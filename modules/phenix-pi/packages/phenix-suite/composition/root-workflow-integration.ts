import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
} from "@matthis-k/phenix-flow/index.ts";
import type { Difficulty, TaskProfile } from "@matthis-k/phenix-kernel/task.ts";
import { loadRoutingConfig, validateConfig } from "@matthis-k/phenix-routing/config.ts";
import { modelRegistry } from "@matthis-k/phenix-routing/registry.ts";
import { extractRootTurnInput } from "@matthis-k/phenix-routing/root-turn.ts";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import { listRecords } from "../subagents/handle-store.ts";
import { phenixRootModelScope } from "./model-scope.ts";
import { prepareRootWorkflowEntry } from "./root-workflow-entry.ts";

async function initializeRootWorkflow(input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly definitionId: string;
  readonly difficulty: Difficulty;
  readonly taskProfile: TaskProfile;
  readonly capabilityArtifactHash: string;
}): Promise<WorkflowRuntimeRecord> {
  return createWorkflowRecord(input.cwd, {
    instanceId: `wf_${randomUUID()}`,
    actorId: `root_${input.sessionId}`,
    sessionId: input.sessionId,
    definitionId: input.definitionId,
    difficulty: input.difficulty,
    taskProfile: input.taskProfile,
    actorRole: "coordinator",
    capabilityArtifactHash: input.capabilityArtifactHash,
  });
}

export interface RootWorkflowIntegrationOptions {
  readonly workflowDefinitionId: string;
}

/** Register deterministic root routing and workflow authority bootstrap. */
export default async function rootWorkflowIntegration(
  pi: ExtensionAPI,
  options: RootWorkflowIntegrationOptions = { workflowDefinitionId: "phenix-default" },
): Promise<void> {
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

    const isNewTurn = runtime.currentTurnId !== turn.turnId;
    if (isNewTurn) runtime.currentTurnId = turn.turnId;

    const cwd = ctx.cwd;
    const artifact = runtime.capabilityArtifact as AgentCapabilityArtifact | undefined;
    if (!artifact) {
      throw new Error(
        "Cannot initialize the Phenix workflow: agent capability discovery did not complete.",
      );
    }

    const { profile, difficulty } = await prepareRootWorkflowEntry({
      sessionId,
      selectedModel,
      userMessage: turn.userMessage,
      config,
    });

    let workflowRecord: WorkflowRuntimeRecord;
    if (!runtime.activeWorkflow || isNewTurn) {
      workflowRecord = await initializeRootWorkflow({
        cwd,
        sessionId,
        definitionId: options.workflowDefinitionId,
        difficulty,
        taskProfile: profile,
        capabilityArtifactHash: artifact.artifactHash,
      });
      runtime.activeWorkflow = {
        instanceId: workflowRecord.instanceId,
        actorId: workflowRecord.actorId,
      };
    } else {
      const { readWorkflowRecord } = await import("@matthis-k/phenix-flow/workflow-store.ts");
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
        cwd,
      },
    });

    // Resolve and inject the initial legal target-agent set before model
    // inference. The model never asks for or echoes workflow state.
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
      "The deterministic Phenix workflow owns the current node, transition selection, role selection, output schemas, models, tools, and delegation depth. ";
    workflowGuidance +=
      "Your legal target agents have already been resolved and are listed below. Use phenix_workflow with action=spawn, one advertised agent, and a bounded task when an isolated child can absorb substantial intermediate context that you will not need for your remaining work, or when independent execution materially improves evidence, planning, implementation, testing, or review. Prefer delegation for broad reconnaissance that can be compressed into relevant files, symbols, constraints, and uncertainties, and for mechanical execution of an already-settled plan. Keep decision-critical source inspection and reasoning in this session when their details are required for architecture, integration, acceptance, or final synthesis. Do not delegate trivial work or work you would need to repeat after the handoff.\n\n";
    workflowGuidance += workflowProjection
      ? formatWorkflowProjection(workflowProjection)
      : "Workflow authority could not be projected; complete the task directly.\n";

    const systemPrompt = phenixRootModelScope.contributeSystemPrompt({
      model: selectedModel,
      systemPrompt: event.systemPrompt,
      contribution: workflowGuidance,
    });
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });
}
