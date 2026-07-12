import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  difficultyForProfile,
  deriveTaskProfileFromText,
  type Difficulty,
  type TaskProfile,
} from "../phenix-kernel/task.ts";
import {
  loadRoutingConfig,
  buildBundledConfig,
  validateConfig,
} from "../phenix-routing/config.ts";
import { resolveRoute } from "../phenix-routing/resolver.ts";
import { getSessionRuntime } from "../phenix-routing/state.ts";
import { setActiveRouteForSession } from "../phenix-routing/stream-proxy.ts";
import { modelSetForModelId, PHENIX_PROVIDER } from "../phenix-routing/provider.ts";
import { modelRegistry } from "../phenix-routing/registry.ts";
import { extractRootTurnInput } from "../phenix-routing/root-turn.ts";

import { listRecords } from "../phenix-subagents/handle-store.ts";

import {
  buildCapabilityArtifact,
  persistCapabilityArtifact,
  createWorkflowRecord,
  buildRootWorkflowProjection,
  formatWorkflowProjection,
  getAgentDiscoveryHelper,
  registerSession,
  buildWorkflowRuntimeDependencies,
  type WorkflowRuntimeRecord,
  type AgentCapabilityArtifact,
} from "../phenix-workflow/index.ts";

// ── Root workflow initialization ────────────────────────────────────────────

/**
 * Initialize a root workflow instance for a new user task.
 *
 * The task profile must be derived once by the caller and passed in — do not
 * call deriveTaskProfileFromText again inside this function.
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

// ── Pi integration ──────────────────────────────────────────────────────────

export default async function rootWorkflowIntegration(
  pi: ExtensionAPI,
): Promise<void> {
  const config = loadRoutingConfig();
  const bundledConfig = buildBundledConfig();

  const diagnostics = validateConfig(config, bundledConfig);
  const startupErrors = diagnostics.filter((d) => d.severity === "error");
  if (startupErrors.length > 0) {
    console.error("[phenix-workflow] Routing configuration errors:");
    for (const error of startupErrors) {
      console.error(`  ERROR: ${error.message}`);
    }
  }

  // Build agent capability artifact at session startup.
  pi.on("session_start", async (_event, ctx) => {
    modelRegistry.bind(ctx);

    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const runtime = getSessionRuntime(sessionId);
    const cwd = ctx.cwd ?? process.cwd();

    try {
      const discovery = getAgentDiscoveryHelper();
      const discovered = await discovery.discoverAgents({ cwd, scope: "both" });
      const artifact = buildCapabilityArtifact(discovered);
      runtime.capabilityArtifact = artifact;

      try {
        persistCapabilityArtifact(cwd, artifact);
      } catch {
        // Best-effort diagnostic persistence.
      }
    } catch (err) {
      console.error("[phenix-workflow] Agent capability discovery failed:", err);
    }

    return {};
  });

  // Cache messages for root-turn extraction.
  pi.on("context", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const runtime = getSessionRuntime(sessionId);

    const eventAny = _event as Record<string, unknown>;
    if (Array.isArray(eventAny.messages)) {
      runtime.cachedMessages = eventAny.messages;
    }
    return {};
  });

  // Resolve the coordinator route and inject deterministic workflow authority.
  pi.on("before_agent_start", async (_event, ctx) => {
    modelRegistry.bind(ctx);

    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const selectedModel = ctx.model;
    const selectedProvider = selectedModel?.provider;
    const selectedModelId = selectedModel?.id;

    // Only intervene for the virtual Phenix provider.
    if (selectedProvider !== PHENIX_PROVIDER) return {};

    const runtime = getSessionRuntime(sessionId);

    const eventPrompt = (_event as { prompt?: unknown }).prompt;
    const cachedMessages = runtime.cachedMessages;
    const turn = Array.isArray(cachedMessages)
      ? extractRootTurnInput(
          cachedMessages as Parameters<typeof extractRootTurnInput>[0],
          ctx,
        )
      : extractRootTurnInput(
          [
            {
              role: "user",
              content: typeof eventPrompt === "string" ? eventPrompt : "",
              timestamp: Date.now(),
            },
          ] as Parameters<typeof extractRootTurnInput>[0],
          ctx,
        );

    const profile = deriveTaskProfileFromText(turn.userMessage, []);
    const difficulty = difficultyForProfile(profile);

    const isNewTurn = runtime.currentTurnId !== turn.turnId;
    if (isNewTurn) runtime.currentTurnId = turn.turnId;

    const cwd = ctx.cwd ?? process.cwd();

    const artifact = runtime.capabilityArtifact as AgentCapabilityArtifact | undefined;
    if (!artifact) {
      throw new Error(
        "Cannot initialize the Phenix workflow: " +
        "agent capability discovery did not complete.",
      );
    }

    const explicitModelSet = selectedModelId ? modelSetForModelId(selectedModelId) : undefined;
    if (explicitModelSet) runtime.modelSet = explicitModelSet;

    const route = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      difficulty,
      modelRegistry,
      config,
    });

    if (route.difficulty !== difficulty) {
      throw new Error(
        `Coordinator route difficulty mismatch: ` +
        `workflow=${difficulty}, route=${route.difficulty}`,
      );
    }

    runtime.activeRoute = route;
    setActiveRouteForSession(sessionId, route);

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
      const existing = (await import("../phenix-workflow/workflow-store.ts"))
        .readWorkflowRecord(
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

    const dependencies = buildWorkflowRuntimeDependencies({
      cwd,
      sessionId,
      source: {
        kind: "root",
        sessionId,
      },
      handleStore: { listRecords },
    });

    const workflowProjection = buildRootWorkflowProjection({
      definition: dependencies.definition,
      runtime: dependencies.record,
      authority: dependencies.authority,
      activeHandles: dependencies.activeHandles,
    });

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
}
