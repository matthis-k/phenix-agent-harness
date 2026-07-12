import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  MODEL_SET_IDS,
  type Difficulty,
} from "./types.ts";

import {
  loadRoutingConfig,
  validateConfig,
  buildBundledConfig,
} from "./config.ts";
import {
  resolveRoute,
} from "./resolver.ts";
import {
  getSessionRuntime,
} from "./state.ts";
import {
  getActiveRouteForSession,
  setActiveRouteForSession,
} from "./stream-proxy.ts";
import {
  registerPhenixProvider,
  PHENIX_PROVIDER,
  modelSetForModelId,
} from "./provider.ts";

import { modelRegistry } from "./registry.ts";

export { modelRegistry, getActiveRouteForSession, setActiveRouteForSession };

// ── Workflow module imports ─────────────────────────────────────────────────

import {
  PHENIX_DEFAULT_WORKFLOW,
  buildRootWorkflowProjection,
  formatWorkflowProjection,
  buildCapabilityArtifact,
  persistCapabilityArtifact,
  createWorkflowRecord,
  resolveDelegationOptions,
  getAgentDiscoveryHelper,
  type ModelWorkflowProjection,
  type DelegationAuthority,
  type WorkflowRuntimeRecord,
} from "../phenix-workflow/index.ts";

import {
  rolePreset,
} from "../phenix-subagents/role-presets.ts";
import { setRootWorkflowData, setRootCapabilityArtifact } from "../phenix-subagents/contract-runtime-context.ts";
import { difficultyForProfile } from "./classifier.ts";
import { deriveTaskProfile } from "../phenix-subagents/policy.ts";

import type { AgentRole } from "../phenix-subagents/agent-types.ts";

// ── Root workflow initialization ────────────────────────────────────────────

/**
 * Initialize a root workflow instance for a new user task.
 */
async function initializeRootWorkflow(
  cwd: string,
  sessionId: string,
  difficulty: Difficulty,
  task: string,
  requirements: readonly string[],
  capabilityArtifactHash: string,
): Promise<WorkflowRuntimeRecord> {
  const instanceId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const actorId = `root_${sessionId}`;

  const profile = deriveTaskProfile(null, task, requirements);

  return createWorkflowRecord(cwd, {
    instanceId,
    actorId,
    sessionId,
    definitionId: "phenix-default",
    difficulty,
    taskProfile: profile,
    actorRole: "coordinator",
    capabilityArtifactHash,
  });
}

// ── Build root delegation authority ─────────────────────────────────────────

function buildRootDelegationAuthority(
  capabilityArtifactHash: string,
): DelegationAuthority {
  // Root has unrestricted role authority - all roles from coordinator preset
  // Coordinator preset has allowedChildren = all roles
  const coordinatorPreset = rolePreset("implementer"); // Use any preset to get all tools
  const allRoles: AgentRole[] = ["scout", "planner", "architect", "implementer", "tester", "critic", "finalizer"];

  return {
    roles: {
      presetRevision: 1,
      role: null,
      source: {
        inherited: false,
        patch: { additional: [], removed: [] },
      },
      effective: [...allRoles],
    },
    availableRoles: [...allRoles],
    remainingDepth: 4, // Root maximum
    transitionAuthority: { kind: "unrestricted" },
  };
}

// ── Derive difficulty from task text ─────────────────────────────────────────

function deriveDifficulty(task: string, requirements: readonly string[]): Difficulty {
  const profile = deriveTaskProfile(null, task, requirements);
  return difficultyForProfile(profile);
}

// ── Extension entry point ───────────────────────────────────────────────────

export default async function phenixRouting(
  pi: ExtensionAPI,
): Promise<void> {
  const config = loadRoutingConfig();
  const bundledConfig = buildBundledConfig();

  // --- Validate bundled config at startup ---
  const diagnostics = validateConfig(config, bundledConfig);
  const startupErrors = diagnostics.filter((d) => d.severity === "error");
  if (startupErrors.length > 0) {
    console.error("[phenix-routing] Configuration errors:");
    for (const error of startupErrors) {
      console.error(`  ERROR: ${error.message}`);
    }
  }

  // --- Register virtual provider ---
  registerPhenixProvider(pi);

  // --- Session start ---
  pi.on("session_start", async (_event, ctx) => {
    modelRegistry.bind(ctx);

    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const runtime = getSessionRuntime(sessionId);

    // Build agent capability artifact at session startup.
    const cwd = ctx.cwd ?? process.cwd();
    try {
      const discovery = getAgentDiscoveryHelper();
      const discovered = await discovery.discoverAgents({ cwd, scope: "both" });
      const artifact = buildCapabilityArtifact(discovered);
      runtime.capabilityArtifact = artifact;

      // Share artifact with the subagents delegate handler.
      setRootCapabilityArtifact(artifact);

      // Persist diagnostic copy
      try {
        persistCapabilityArtifact(cwd, artifact);
      } catch {
        // Best-effort persistence
      }
    } catch (err) {
      console.error("[phenix-routing] Agent capability discovery failed:", err);
    }

    return {};
  });

  // --- before_agent_start ---
  pi.on("before_agent_start", async (_event, ctx) => {
    modelRegistry.bind(ctx);

    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const selectedModel = ctx.model;
    const selectedProvider = selectedModel?.provider;
    const selectedModelId = selectedModel?.id;

    // Only intervene for phenix provider
    if (selectedProvider !== PHENIX_PROVIDER) return {};

    const runtime = getSessionRuntime(sessionId);

    // Set model set from the selected phenix model (e.g. "mixed" from phenix/mixed).
    const explicitModelSet = selectedModelId ? modelSetForModelId(selectedModelId) : undefined;
    if (explicitModelSet) {
      runtime.modelSet = explicitModelSet;
    }

    // Resolve route for coordinator role using the model set determined from selection
    const route = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      modelRegistry,
      config,
    });

    // Store active route for stream-proxy
    runtime.activeRoute = route;
    setActiveRouteForSession(sessionId, route);

    // Get the actual user task text from the event.
    // The _event may have the prompt/user task in different locations
    // depending on the Pi version. Try several known patterns.
    let taskText = "";
    let taskReqs: string[] = [];

    const eventAny = _event as Record<string, unknown>;
    if (typeof eventAny.systemPrompt === "string") {
      taskText = eventAny.systemPrompt;
    } else if (typeof eventAny.prompt === "string") {
      taskText = eventAny.prompt;
    } else if (typeof eventAny.userPrompt === "string") {
      taskText = eventAny.userPrompt;
    }

    // Derive difficulty from the task text
    const difficulty = deriveDifficulty(taskText, taskReqs);

    // Initialize root workflow
    const cwd = ctx.cwd ?? process.cwd();
    const capabilityArtifactHash = runtime.capabilityArtifact?.artifactHash ??
      "0000000000000000000000000000000000000000000000000000000000000000";

    // Check if there's already an active workflow for this turn
    if (!runtime.activeWorkflow || runtime.turnCount === 0) {
      const workflowRecord = await initializeRootWorkflow(
        cwd,
        sessionId,
        difficulty,
        taskText,
        taskReqs,
        capabilityArtifactHash,
      );

      runtime.activeWorkflow = {
        instanceId: workflowRecord.instanceId,
        actorId: workflowRecord.actorId,
      };

      // Share root workflow data with the subagents delegate handler.
      setRootWorkflowData({
        instanceId: workflowRecord.instanceId,
        actorId: workflowRecord.actorId,
      });
    }

    // Build workflow projection
    const activeWorkflow = runtime.activeWorkflow;
    let workflowProjection: ModelWorkflowProjection | null = null;

    if (activeWorkflow) {
      const authority = buildRootDelegationAuthority(capabilityArtifactHash);
      const definition = PHENIX_DEFAULT_WORKFLOW;

      // Re-read the workflow record to get current state
      const { readWorkflowRecord: readWf } = await import(
        "../phenix-workflow/workflow-store.ts"
      );

      const wfRecord = readWf(cwd, activeWorkflow.instanceId, activeWorkflow.actorId);

      if (wfRecord) {
        workflowProjection = buildRootWorkflowProjection({
          definition,
          runtime: wfRecord,
          authority,
          activeHandles: [],
        });
      }
    }

    // Build the system prompt injection
    let workflowGuidance = `## Phenix Workflow Orchestration\n\n`;
    workflowGuidance += `You are running with a Phenix model set (${runtime.modelSet}). `;
    workflowGuidance += `Every task must use the deterministic Phenix workflow. `;
    workflowGuidance += `Only delegate through the transitions projected below.\n\n`;

    if (workflowProjection) {
      workflowGuidance += formatWorkflowProjection(workflowProjection);
    } else {
      workflowGuidance += `Workflow state not yet initialized. Start by classifying the task.\n`;
    }

    return {
      systemPrompt: `${_event.systemPrompt}\n\n${workflowGuidance}`,
    };
  });

  // --- agent_end ---
  pi.on("agent_end", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const runtime = getSessionRuntime(sessionId);
    runtime.turnCount += 1;
    return {};
  });

  // --- /phenix-route command ---
  pi.registerCommand("phenix-route", {
    description: "Display the current Phenix routing state",

    handler: async (_args, ctx) => {
      const sessionId = ctx.session?.id ?? "default";
      const runtime = getSessionRuntime(sessionId);
      const route = runtime.activeRoute ?? getActiveRouteForSession(sessionId);

      const availableModels = MODEL_SET_IDS.map((id) => `${PHENIX_PROVIDER}/${id}`).join(", ");

      const lines: string[] = [
        `Virtual provider: ${PHENIX_PROVIDER}`,
        `Active model set: ${runtime.modelSet}`,
        `Available model-set models: ${availableModels}`,
      ];

      if (runtime.capabilityArtifact) {
        lines.push(
          `Capability artifact hash: ${runtime.capabilityArtifact.artifactHash}`,
        );
      }

      if (runtime.activeWorkflow) {
        lines.push(
          `Active workflow: ${runtime.activeWorkflow.instanceId}/${runtime.activeWorkflow.actorId}`,
        );
      }

      if (route) {
        lines.push(
          `Difficulty: ${route.difficulty}`,
          `Role: ${route.role}`,
          `Capability: ${route.capability}`,
          `Thinking: ${route.thinking}`,
          `Candidate pool: ${route.pool}`,
          `Resolved model: ${route.model.provider}/${route.model.model}`,
          `Candidate index: ${route.candidateIndex}`,
          `Avoided-model fallback: ${route.usedAvoidedModelFallback}`,
        );
        if (route.avoidedModel) {
          lines.push(`Avoided model: ${route.avoidedModel.provider}/${route.avoidedModel.model}`);
        }
      } else {
        lines.push("No active route");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
