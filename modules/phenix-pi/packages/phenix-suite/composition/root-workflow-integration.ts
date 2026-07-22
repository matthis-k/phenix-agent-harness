import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AgentCapabilityArtifact,
  abandonWorkflowRecord,
  buildCapabilityArtifact,
  buildRootWorkflowProjection,
  buildWorkflowRuntimeDependencies,
  createWorkflowRecord,
  formatWorkflowProjection,
  getAgentDiscoveryHelper,
  isTerminalState,
  persistCapabilityArtifact,
  readWorkflowRecord,
  registerSession,
  unregisterSession,
  type WorkflowRuntimeRecord,
} from "@matthis-k/phenix-flow/index.ts";
import type { Difficulty, TaskProfile } from "@matthis-k/phenix-kernel/task.ts";
import { loadRoutingConfig, validateConfig } from "@matthis-k/phenix-routing/config.ts";
import { modelRegistry } from "@matthis-k/phenix-routing/registry.ts";
import { createRootTurnInput } from "@matthis-k/phenix-routing/root-turn.ts";
import { clearSessionRuntime, getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import { clearActiveRouteForSession } from "@matthis-k/phenix-routing/stream-proxy.ts";
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

type WorkflowControlAction = "resume" | "discard-only";

function workflowControlAction(message: string): WorkflowControlAction | undefined {
  const normalized = message
    .trim()
    .replace(/[.!?]+$/u, "")
    .toLowerCase();
  if (/^(?:\/workflow\s+resume|continue|keep\s+going)$/u.test(normalized)) return "resume";
  if (/^(?:\/workflow\s+discard|stop|cancel|discard(?:\s+this)?)$/u.test(normalized)) {
    return "discard-only";
  }
  return undefined;
}

function releaseActiveWorkflowSlot(input: {
  readonly sessionId: string;
  readonly runtime: ReturnType<typeof getSessionRuntime>;
  readonly workflowGate: WorkflowTurnGate;
}): void {
  unregisterSession(input.sessionId);
  delete input.runtime.activeWorkflow;
  input.runtime.currentUserTask = undefined;
  input.runtime.activeRoute = null;
  clearActiveRouteForSession(input.sessionId);
  input.workflowGate.clearSession(input.sessionId);
}

function workflowControlPrompt(input: {
  readonly model: { readonly provider?: string | null } | null | undefined;
  readonly systemPrompt: string;
  readonly message: string;
}): { readonly systemPrompt: string } | undefined {
  const contribution = [
    "## Phenix Workflow Orchestration",
    "",
    input.message,
    "Do not start a replacement workflow for this control command. Acknowledge the workflow lifecycle state and wait for the next user task.",
  ].join("\n");
  const systemPrompt = phenixRootModelScope.contributeSystemPrompt({
    model: input.model,
    systemPrompt: input.systemPrompt,
    contribution,
  });
  return systemPrompt === undefined ? undefined : { systemPrompt };
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
    const selectedModel = ctx.model as { readonly provider: string; readonly id: string };
    if (!phenixRootModelScope.includes(selectedModel)) return;

    const runtime = getSessionRuntime(sessionId);
    // before_agent_start is Pi's user-submission boundary. Build identity from
    // that event rather than a cached context snapshot: snapshots are emitted
    // later and compaction can rewrite their message positions.
    runtime.rootTurnCount += 1;
    const turn = createRootTurnInput(event.prompt, sessionId, runtime.rootTurnCount);
    runtime.currentTurnId = turn.turnId;
    const cwd = ctx.cwd;
    const artifact = runtime.capabilityArtifact as AgentCapabilityArtifact | undefined;
    if (!artifact) {
      throw new Error(
        "Cannot initialize the Phenix workflow: agent capability discovery did not complete.",
      );
    }

    let active = runtime.activeWorkflow;
    let existing = active && readWorkflowRecord(cwd, active.instanceId, active.actorId);
    if (active && (!existing || isTerminalState(existing.state))) {
      releaseActiveWorkflowSlot({ sessionId, runtime, workflowGate: options.workflowGate });
      active = undefined;
      existing = undefined;
    }

    const control = workflowControlAction(turn.userMessage);
    if (control === "discard-only") {
      if (existing) {
        abandonWorkflowRecord(cwd, existing, `Discarded by user message: ${turn.userMessage}`);
      }
      releaseActiveWorkflowSlot({ sessionId, runtime, workflowGate: options.workflowGate });
      await prepareRootWorkflowEntry({
        sessionId,
        selectedModel,
        userMessage: turn.userMessage,
        config,
        fallbackWorkflowDefinitionId: options.workflowDefinitionId,
      });
      return workflowControlPrompt({
        model: selectedModel,
        systemPrompt: event.systemPrompt,
        message: existing
          ? "The active Phenix workflow was abandoned and the session is idle for the next task."
          : "No active Phenix workflow was present; the session remains idle for the next task.",
      });
    }
    if (control === "resume" && !existing) {
      releaseActiveWorkflowSlot({ sessionId, runtime, workflowGate: options.workflowGate });
      await prepareRootWorkflowEntry({
        sessionId,
        selectedModel,
        userMessage: turn.userMessage,
        config,
        fallbackWorkflowDefinitionId: options.workflowDefinitionId,
      });
      return workflowControlPrompt({
        model: selectedModel,
        systemPrompt: event.systemPrompt,
        message:
          "No active Phenix workflow is available to resume; the session is idle for the next task.",
      });
    }

    const resumed = existing !== undefined && !isTerminalState(existing.state);
    let workflowRecord: WorkflowRuntimeRecord;
    let workflowDescriptor: {
      readonly preset: string;
      readonly workflowDefinitionId: string;
      readonly source: string;
      readonly reason: string;
    };

    if (resumed && existing) {
      workflowRecord = existing;
      // A root workflow remains the session's sole active execution until its
      // persisted state is terminal. This includes Pi turns triggered to
      // reconcile a background child handle.
      runtime.currentUserTask ??= turn.userMessage;
      workflowDescriptor = {
        preset: "resumed",
        workflowDefinitionId: workflowRecord.definitionId,
        source: "active-session",
        reason: "Preserved the existing non-terminal workflow instance.",
      };
    } else {
      if (active) unregisterSession(sessionId);
      const { profile, difficulty, workflow } = await prepareRootWorkflowEntry({
        sessionId,
        selectedModel,
        userMessage: turn.userMessage,
        config,
        fallbackWorkflowDefinitionId: options.workflowDefinitionId,
      });
      workflowRecord = await initializeRootWorkflow({
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
      runtime.currentUserTask = turn.userMessage;
      workflowDescriptor = workflow;
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
    if (resumed) {
      options.workflowGate.resumeTurn(sessionId, turn.turnId);
    } else {
      options.workflowGate.beginTurn({
        sessionId,
        turnId: turn.turnId,
        userTask: turn.userMessage,
        requiredAgents: required,
      });
    }

    const workflowUserTask = runtime.currentUserTask ?? turn.userMessage;
    let workflowGuidance = "## Phenix Workflow Orchestration\n\n";
    workflowGuidance += `Workflow preset: ${workflowDescriptor.preset}\n`;
    workflowGuidance += `Workflow definition: ${workflowDescriptor.workflowDefinitionId}\n`;
    workflowGuidance += `Selection source: ${workflowDescriptor.source}\n`;
    workflowGuidance += `Selection reason: ${workflowDescriptor.reason}\n`;
    workflowGuidance += `Difficulty: ${workflowRecord.difficulty}\n\n`;
    workflowGuidance += `You are running with a Phenix model set (${runtime.modelSet}). `;
    workflowGuidance +=
      "The deterministic Phenix workflow owns the current node, transition selection, role selection, output schemas, models, tools, and delegation depth. ";
    if (resumed) {
      workflowGuidance +=
        `This is a resumed non-terminal workflow instance for the original task: ${JSON.stringify(workflowUserTask)}. ` +
        `The latest user message is an interruption or amendment: ${JSON.stringify(turn.userMessage)}. ` +
        "Do not start a replacement workflow from inside this workflow; resume or amend the existing instance unless the user explicitly discards it. ";
    }
    if (required.length > 0) {
      workflowGuidance +=
        `This node has required workflow transitions. You may first read any required SKILL.md files locally. Do not delegate skill loading, contract loading, workflow inspection, or other Phenix harness preparation. ` +
        `Then call phenix_workflow with action=spawn and one required target agent (${required.join(", ")}). The task field may identify a useful focus, but the runtime binds required root execution to the complete user request: ${JSON.stringify(workflowUserTask)}. ` +
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

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    unregisterSession(sessionId);
    clearActiveRouteForSession(sessionId);
    clearSessionRuntime(sessionId);
    options.workflowGate.clearSession(sessionId);
  });
}
