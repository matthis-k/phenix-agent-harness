import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  type Difficulty,
  deriveTaskProfileFromText,
  difficultyForProfile,
  type TaskProfile,
} from "../phenix-kernel/task.ts";
import { loadRoutingConfig, validateConfig } from "../phenix-routing/config.ts";
import { modelSetForModelId } from "../phenix-routing/provider.ts";
import { modelRegistry } from "../phenix-routing/registry.ts";
import { resolveRoute } from "../phenix-routing/resolver.ts";
import { extractRootTurnInput } from "../phenix-routing/root-turn.ts";
import { getSessionRuntime } from "../phenix-routing/state.ts";
import { setActiveRouteForSession } from "../phenix-routing/stream-proxy.ts";
import { listRecords } from "../phenix-subagents/handle-store.ts";
import {
  type AgentCapabilityArtifact,
  buildCapabilityArtifact,
  buildRootWorkflowProjection,
  buildWorkflowRuntimeDependencies,
  createWorkflowRecord,
  formatWorkflowProjection,
  getAgentDiscoveryHelper,
  persistCapabilityArtifact,
  registerSession,
  type WorkflowRuntimeRecord,
} from "../phenix-workflow/index.ts";
import { phenixRootModelScope } from "./model-scope.ts";

async function initializeRootWorkflow(input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly difficulty: Difficulty;
  readonly taskProfile: TaskProfile;
  readonly capabilityArtifactHash: string;
}): Promise<WorkflowRuntimeRecord> {
  return createWorkflowRecord(input.cwd, {
    instanceId: `wf_${randomUUID()}`,
    actorId: `root_${input.sessionId}`,
    sessionId: input.sessionId,
    definitionId: "phenix-default",
    difficulty: input.difficulty,
    taskProfile: input.taskProfile,
    actorRole: "coordinator",
    capabilityArtifactHash: input.capabilityArtifactHash,
  });
}

/** Register deterministic root routing and workflow projection. */
export default async function rootWorkflowIntegration(pi: ExtensionAPI): Promise<void> {
  const config = loadRoutingConfig();
  const startupErrors = validateConfig(config).filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (startupErrors.length > 0) {
    console.error("[phenix-workflow] Routing configuration errors:");
    for (const error of startupErrors) {
      console.error(`  ERROR: ${error.message}`);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    modelRegistry.bind(ctx);

    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    const runtime = getSessionRuntime(sessionId);
    const cwd = ctx.cwd;

    try {
      const discovered = await getAgentDiscoveryHelper().discoverAgents({
        cwd,
        scope: "both",
      });
      const artifact = buildCapabilityArtifact(discovered);
      runtime.capabilityArtifact = artifact;

      try {
        persistCapabilityArtifact(cwd, artifact);
      } catch {
        // Diagnostic persistence is best-effort; in-memory authority remains valid.
      }
    } catch (error) {
      console.error("[phenix-workflow] Agent capability discovery failed:", error);
    }
  });

  pi.on("context", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    getSessionRuntime(sessionId).cachedMessages = event.messages;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    modelRegistry.bind(ctx);

    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    const selectedModel = ctx.model;
    if (!phenixRootModelScope.includes(selectedModel)) return;

    const runtime = getSessionRuntime(sessionId);
    const cachedMessages = runtime.cachedMessages;
    const turn = Array.isArray(cachedMessages)
      ? extractRootTurnInput(cachedMessages, ctx)
      : extractRootTurnInput(
          [
            {
              role: "user",
              content: event.prompt,
              timestamp: Date.now(),
            },
          ],
          ctx,
        );

    const profile = deriveTaskProfileFromText(turn.userMessage, []);
    const difficulty = difficultyForProfile(profile);
    const isNewTurn = runtime.currentTurnId !== turn.turnId;
    if (isNewTurn) runtime.currentTurnId = turn.turnId;

    const cwd = ctx.cwd;
    const artifact = runtime.capabilityArtifact as AgentCapabilityArtifact | undefined;
    if (!artifact) {
      throw new Error(
        "Cannot initialize the Phenix workflow: agent capability discovery did not complete.",
      );
    }

    const explicitModelSet = modelSetForModelId(selectedModel.id);
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
        `Coordinator route difficulty mismatch: workflow=${difficulty}, route=${route.difficulty}`,
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
      const { readWorkflowRecord } = await import("../phenix-workflow/workflow-store.ts");
      const existing = readWorkflowRecord(
        cwd,
        runtime.activeWorkflow.instanceId,
        runtime.activeWorkflow.actorId,
      );
      if (!existing) {
        throw new Error(
          `Root workflow record not found for instance "${runtime.activeWorkflow.instanceId}".`,
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
      source: { kind: "root", sessionId },
      handleStore: { listRecords },
    });
    const workflowProjection = buildRootWorkflowProjection({
      definition: dependencies.definition,
      runtime: dependencies.record,
      authority: dependencies.authority,
      activeHandles: dependencies.activeHandles,
    });

    let workflowGuidance = "## Phenix Workflow Orchestration\n\n";
    workflowGuidance += `You are running with a Phenix model set (${runtime.modelSet}). `;
    workflowGuidance +=
      "The deterministic Phenix workflow owns role selection, output schemas, models, tools, and delegation depth. ";
    workflowGuidance +=
      "Use the workflow API: call phenix_workflow for fresh authority, then phenix_create_subagent with one returned transition.\n\n";
    workflowGuidance += workflowProjection
      ? formatWorkflowProjection(workflowProjection)
      : "Workflow state not yet initialized. Start by classifying the task.\n";

    const systemPrompt = phenixRootModelScope.contributeSystemPrompt({
      model: selectedModel,
      systemPrompt: event.systemPrompt,
      contribution: workflowGuidance,
    });
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });
}
