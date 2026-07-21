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
import { createRootTurnInput } from "@matthis-k/phenix-routing/root-turn.ts";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import { listRecords } from "../subagents/handle-store.ts";
import { phenixRootModelScope } from "./model-scope.ts";
import { prepareRootWorkflowEntry } from "./root-workflow-entry.ts";
import type { WorkflowTurnGate } from "./workflow-turn-gate.ts";

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
  /** Fallback definition for tasks that do not match a specialized preset. */
  readonly workflowDefinitionId: string;
  readonly workflowGate: WorkflowTurnGate;
}

function requiredAgents(
  projection: ReturnType<typeof buildRootWorkflowProjection>,
): readonly string[] {
  if (!projection) return [];
  return projection.options
    .filter((option) => option.category === "required")
    .map((option) => option.agent);
}

/** Register deterministic root routing and per-turn workflow selection. */
export default async function rootWorkflowIntegration(
  pi: ExtensionAPI,
  options: RootWorkflowIntegrationOptions,
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

  pi.on("before_agent_start", async (event, ctx) => {
    modelRegistry.bind(ctx);

    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    const selectedModel = ctx.model;
    if (!phenixRootModelScope.includes(selectedModel)) return;

    const runtime = getSessionRuntime(sessionId);
    // before_agent_start is Pi's user-submission boundary. Build identity from
    // that event rather than a cached context snapshot: snapshots are emitted
    // later and compaction can rewrite their message positions.
    runtime.rootTurnCount += 1;
    const turn = createRootTurnInput(event.prompt, sessionId, runtime.rootTurnCount);
    runtime.currentTurnId = turn.turnId;
    runtime.currentUserTask = turn.userMessage;

    const cwd = ctx.cwd;
    const artifact = runtime.capabilityArtifact as AgentCapabilityArtifact | undefined;
    if (!artifact) {
      throw new Error(
        "Cannot initialize the Phenix workflow: agent capability discovery did not complete.",
      );
    }

    const { profile, difficulty, workflow } = await prepareRootWorkflowEntry({
      sessionId,
      selectedModel,
      userMessage: turn.userMessage,
      config,
      fallbackWorkflowDefinitionId: options.workflowDefinitionId,
    });
    const workflowRecord = await initializeRootWorkflow({
      cwd,
      sessionId,
      definitionId: workflow.workflowDefinitionId,
      difficulty,
      taskProfile: profile,
      capabilityArtifactHash: artifact.artifactHash,
    });
    runtime.activeWorkflow = {
      instanceId: workflowRecord.instanceId,
      actorId: workflowRecord.actorId,
    };

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
    // inference. Required transitions are enforced by the shared turn gate.
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
    const required = requiredAgents(workflowProjection);
    options.workflowGate.beginTurn({
      sessionId,
      turnId: turn.turnId,
      userTask: turn.userMessage,
      requiredAgents: required,
    });

    let workflowGuidance = "## Phenix Workflow Orchestration\n\n";
    workflowGuidance += `Workflow preset: ${workflow.preset}\n`;
    workflowGuidance += `Workflow definition: ${workflow.workflowDefinitionId}\n`;
    workflowGuidance += `Selection source: ${workflow.source}\n`;
    workflowGuidance += `Selection reason: ${workflow.reason}\n`;
    workflowGuidance += `Difficulty: ${difficulty}\n\n`;
    workflowGuidance += `You are running with a Phenix model set (${runtime.modelSet}). `;
    workflowGuidance +=
      "The deterministic Phenix workflow owns the current node, transition selection, role selection, output schemas, models, tools, and delegation depth. ";
    if (required.length > 0) {
      workflowGuidance +=
        `This node has required workflow transitions. You may first read any required SKILL.md files locally. Do not delegate skill loading, contract loading, workflow inspection, or other Phenix harness preparation. ` +
        `Then call phenix_workflow with action=spawn and one required target agent (${required.join(", ")}). The task field may identify a useful focus, but the runtime binds required root execution to the complete user request: ${JSON.stringify(turn.userMessage)}. ` +
        "The runtime blocks repository reads and other execution tools until that required workflow action succeeds, and re-evaluates authority after every spawn result.\n\n";
    } else {
      workflowGuidance +=
        "No required target transition is currently pending. Optional delegation remains available when it materially reduces isolated context.\n\n";
    }
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
