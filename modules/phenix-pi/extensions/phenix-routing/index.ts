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
  buildRootWorkflowProjection,
  formatWorkflowProjection,
  buildCapabilityArtifact,
  persistCapabilityArtifact,
  createWorkflowRecord,
  getAgentDiscoveryHelper,
  registerSession,
  buildWorkflowRuntimeDependencies,
  type WorkflowRuntimeRecord,
} from "../phenix-workflow/index.ts";

import { difficultyForProfile } from "./classifier.ts";
import { deriveTaskProfile, type TaskProfile } from "../phenix-subagents/policy.ts";
import { extractRootTurnInput } from "./root-turn.ts";

// ── Root workflow initialization ────────────────────────────────────────────

/**
 * Initialize a root workflow instance for a new user task.
 *
 * The task profile must be derived once by the caller and passed in —
 * do not call deriveTaskProfile again inside this function.
 */
async function initializeRootWorkflow(input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly difficulty: Difficulty;
  readonly taskProfile: TaskProfile;
  readonly capabilityArtifactHash: string;
}): Promise<WorkflowRuntimeRecord> {
  const instanceId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const actorId = `root_${input.sessionId}`;

  return createWorkflowRecord(input.cwd, {
    instanceId,
    actorId,
    sessionId: input.sessionId,
    definitionId: "phenix-default",
    difficulty: input.difficulty,
    taskProfile: input.taskProfile,
    actorRole: "coordinator",
    capabilityArtifactHash: input.capabilityArtifactHash,
  });
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

  // --- context event (captures Pi messages for user message extraction) ---
  pi.on("context", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const runtime = getSessionRuntime(sessionId);

    // Cache messages for user message extraction in before_agent_start.
    const eventAny = _event as Record<string, unknown>;
    if (Array.isArray(eventAny.messages)) {
      runtime.cachedMessages = eventAny.messages;
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

    // ── Section 1: Extract root task from Pi messages ────────────────
    // Fail closed when no user message is available.
    const cachedMessages = runtime.cachedMessages;
    if (!Array.isArray(cachedMessages)) {
      throw new Error(
        "Cannot initialize the Phenix workflow: " +
        "the current user message is unavailable.",
      );
    }

    const turn = extractRootTurnInput(
      cachedMessages as Parameters<
        typeof extractRootTurnInput
      >[0],
      ctx,
    );

    // ── Section 2: Compute the task profile once ────────────────────
    const profile = deriveTaskProfile(null, turn.userMessage, []);
    const difficulty = difficultyForProfile(profile);

    // ── Section 3: turnId-based workflow lifecycle ──────────────────
    const isNewTurn = runtime.currentTurnId !== turn.turnId;
    if (isNewTurn) {
      runtime.currentTurnId = turn.turnId;
    }

    const cwd = ctx.cwd ?? process.cwd();

    // Fail when capability discovery did not complete.
    const artifact = runtime.capabilityArtifact;
    if (!artifact) {
      throw new Error(
        "Cannot initialize the Phenix workflow: " +
        "agent capability discovery did not complete.",
      );
    }

    // Set model set from the selected phenix model.
    const explicitModelSet = selectedModelId ? modelSetForModelId(selectedModelId) : undefined;
    if (explicitModelSet) {
      runtime.modelSet = explicitModelSet;
    }

    // Resolve route for coordinator role, passing difficulty.
    const route = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      difficulty,
      modelRegistry,
      config,
    });

    // Assert difficulty invariance.
    if (route.difficulty !== difficulty) {
      throw new Error(
        `Coordinator route difficulty mismatch: ` +
        `workflow=${difficulty}, route=${route.difficulty}`,
      );
    }

    // Store active route for stream-proxy
    runtime.activeRoute = route;
    setActiveRouteForSession(sessionId, route);

    // Initialize or clear root workflow based on turn identity.
    let workflowRecord: WorkflowRuntimeRecord;
    if (!runtime.activeWorkflow || isNewTurn) {
      workflowRecord = await initializeRootWorkflow({
        cwd,
        sessionId,
        difficulty,
        taskProfile: profile,
        capabilityArtifactHash: artifact.artifactHash,
      });

      runtime.activeWorkflow = {
        instanceId: workflowRecord.instanceId,
        actorId: workflowRecord.actorId,
      };
    } else {
      // Re-read the existing workflow record.
      const existing = (await import(
        "../phenix-workflow/workflow-store.ts"
      )).readWorkflowRecord(
        cwd,
        runtime.activeWorkflow.instanceId,
        runtime.activeWorkflow.actorId,
      );
      if (!existing) {
        throw new Error(
          `Root workflow record not found for ` +
          `instance "${runtime.activeWorkflow.instanceId}".`,
        );
      }
      workflowRecord = existing;
    }

    // ── Section 4: Register session in the session registry ────────
    registerSession(sessionId, {
      capabilityArtifact: artifact,
      workflowData: {
        turnId: turn.turnId,
        instanceId: workflowRecord.instanceId,
        actorId: workflowRecord.actorId,
        definitionId: workflowRecord.definitionId,
        definitionVersion: workflowRecord.definitionVersion,
        cwd,
      },
    });

    // ── Section 5: Build root projection from the shared runtime service
    const dependencies = buildWorkflowRuntimeDependencies({
      cwd,
      sessionId,
      source: {
        kind: "root",
        sessionId,
      },
    });

    const workflowProjection = buildRootWorkflowProjection({
      definition: dependencies.definition,
      runtime: dependencies.record,
      authority: dependencies.authority,
      activeHandles: dependencies.activeHandles,
    });

    // Build the system prompt injection
    let workflowGuidance = `## Phenix Workflow Orchestration\n\n`;
    workflowGuidance += `You are running with a Phenix model set (${runtime.modelSet}). `;
    workflowGuidance += `The deterministic Phenix workflow owns role selection, output schemas, and models. `;
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
