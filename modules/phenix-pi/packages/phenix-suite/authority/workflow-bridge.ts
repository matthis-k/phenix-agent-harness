import { readWorkflowRecord } from "@matthis-k/phenix-flow/index.ts";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import type { ParentExecutionContext } from "../runtime/workflow-api-types.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowHandleResult,
  WorkflowRuntimePort,
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
} from "../runtime/workflow-runtime-types.ts";
import { assurancePolicyFor } from "./assurance.ts";
import type { ExecutionAuthority } from "./service.ts";
import type { HandleRuntimeState, LegalAction } from "./types.ts";

type SessionRuntime = ReturnType<typeof getSessionRuntime>;

function sessionRuntimeFor(ctx: WorkflowSpawnRequest["ctx"]): SessionRuntime | undefined {
  try {
    return getSessionRuntime(ctx.sessionManager.getSessionId() ?? "default");
  } catch {
    // Injected standalone workflow ports, including tests and non-router clients,
    // remain valid; authority projection is skipped until routing owns a runtime.
    return undefined;
  }
}

function objectiveIdFor(
  ctx: WorkflowSpawnRequest["ctx"],
  parent?: ParentExecutionContext,
): string | undefined {
  if (parent?.kind === "child") return parent.contract.runtime.workflow.instanceId;
  return sessionRuntimeFor(ctx)?.activeWorkflow?.instanceId;
}

function actorIdFor(ctx: WorkflowSpawnRequest["ctx"], parent?: ParentExecutionContext): string {
  if (parent?.kind === "child") return parent.contract.runtime.workflow.actorId;
  return sessionRuntimeFor(ctx)?.activeWorkflow?.actorId ?? "root";
}

function closeSupersededObjective(input: {
  readonly authority: ExecutionAuthority;
  readonly sessionId: string;
  readonly nextObjectiveId: string;
  readonly actorId: string;
}): void {
  const active = input.authority.activeObjectiveForSession(input.sessionId);
  if (!active || active.id === input.nextObjectiveId) return;
  try {
    input.authority.completeObjective(active.id, {
      idempotencyKey: `superseded-complete:${active.id}`,
      actorId: input.actorId,
      expectedRevision: active.revision,
    });
  } catch {
    const current = input.authority.inspectObjective(active.id).objective;
    input.authority.discardObjective(
      active.id,
      `Recovered stale objective before starting ${input.nextObjectiveId}.`,
      {
        idempotencyKey: `superseded-discard:${active.id}`,
        actorId: input.actorId,
        expectedRevision: current.revision,
      },
    );
  }
}

function ensureObjective(input: {
  readonly authority: ExecutionAuthority;
  readonly ctx: WorkflowSpawnRequest["ctx"];
  readonly parent?: ParentExecutionContext;
}): string | undefined {
  const objectiveId = objectiveIdFor(input.ctx, input.parent);
  if (!objectiveId) return undefined;
  try {
    input.authority.inspectObjective(objectiveId);
    return objectiveId;
  } catch {
    // Reconstruct the durable authority from the workflow/contract source after
    // process restart or when an older session first enters the new runtime.
  }

  if (input.parent?.kind === "child") {
    const workflow = input.parent.contract.runtime.workflow;
    const task = input.parent.contract.assignment.task;
    closeSupersededObjective({
      authority: input.authority,
      sessionId: input.parent.sessionId,
      nextObjectiveId: objectiveId,
      actorId: workflow.actorId,
    });
    const policy = assurancePolicyFor({
      userTask: task,
      difficulty: workflow.difficulty,
      mutation: input.parent.contract.runtime.agent === "phenix.implementer" ? "local" : "none",
      deterministicChecksAvailable: input.parent.contract.verification.commands.length > 0,
      userRequestedRigor: input.parent.contract.verification.criticRequired ? "verified" : "normal",
    });
    input.authority.beginObjective(
      {
        id: objectiveId,
        rootSessionId: input.parent.sessionId,
        rootActorId: workflow.parentActorId ?? workflow.actorId,
        userTask: task,
        workflowDefinitionId: workflow.definitionId,
        difficulty: workflow.difficulty,
        assurance: policy.level,
      },
      {
        idempotencyKey: `recover-objective:${objectiveId}`,
        actorId: workflow.actorId,
      },
    );
    return objectiveId;
  }

  const sessionId = input.ctx.sessionManager.getSessionId() ?? "default";
  const runtime = sessionRuntimeFor(input.ctx);
  const active = runtime?.activeWorkflow;
  if (!runtime || !active) return undefined;
  const workflow = readWorkflowRecord(input.ctx.cwd, active.instanceId, active.actorId);
  if (!workflow) return undefined;
  closeSupersededObjective({
    authority: input.authority,
    sessionId,
    nextObjectiveId: objectiveId,
    actorId: workflow.actorId,
  });
  const task = runtime.currentUserTask ?? "Phenix managed objective";
  const policy = assurancePolicyFor({
    userTask: task,
    difficulty: workflow.difficulty,
    mutation: workflow.definitionId.includes("implement") ? "local" : "none",
    deterministicChecksAvailable: true,
    userRequestedRigor: workflow.definitionId.includes("qa") ? "verified" : "normal",
  });
  input.authority.beginObjective(
    {
      id: objectiveId,
      rootSessionId: sessionId,
      rootActorId: workflow.actorId,
      userTask: task,
      workflowDefinitionId: workflow.definitionId,
      difficulty: workflow.difficulty,
      assurance: policy.level,
    },
    {
      idempotencyKey: `recover-objective:${objectiveId}`,
      actorId: workflow.actorId,
    },
  );
  return objectiveId;
}

function legalActions(snapshot: WorkflowAuthoritySnapshot): readonly LegalAction[] {
  return snapshot.workflow.options.map((option) => ({
    id: option.transitionId,
    kind: "delegate" as const,
    purpose: option.purpose,
    description: option.description,
    category: option.category,
    role: option.role,
    outputSchemaId: option.outputSchemaId,
    allowedModes: [...option.allowedModes],
    reason: `Legal from workflow node ${snapshot.workflow.currentState} at revision ${snapshot.workflow.revision}.`,
  }));
}

function runtimeState(status: string): HandleRuntimeState {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "completed":
      return "settled";
    case "cancelled":
      return "cancelled";
    case "orphaned":
      return "orphaned";
    default:
      return "failed";
  }
}

function handleResult(record: {
  readonly id: string;
  readonly subagentId?: string;
  readonly status: string;
  readonly value?: unknown;
  readonly errors?: readonly string[];
}): WorkflowHandleResult {
  return {
    id: record.id,
    ...(record.subagentId ? { subagentId: record.subagentId } : {}),
    status: record.status,
    ...(record.value !== undefined ? { value: record.value } : {}),
    ...(record.errors ? { errors: record.errors } : {}),
  };
}

function reconcileTerminalObjective(input: {
  readonly authority: ExecutionAuthority;
  readonly objectiveId: string;
  readonly actorId: string;
  readonly workflowState: string;
  readonly workflowRevision: number;
}): void {
  const snapshot = input.authority.inspectObjective(input.objectiveId);
  if (["failed", "cancelled"].includes(input.workflowState)) {
    input.authority.failObjective(
      input.objectiveId,
      `Workflow entered terminal state ${input.workflowState}.`,
      {
        idempotencyKey: `workflow-failed:${input.objectiveId}:${input.workflowRevision}`,
        actorId: input.actorId,
        expectedRevision: snapshot.objective.revision,
      },
    );
    return;
  }
  if (input.workflowState === "abandoned") {
    input.authority.discardObjective(input.objectiveId, "Workflow was abandoned.", {
      idempotencyKey: `workflow-abandoned:${input.objectiveId}:${input.workflowRevision}`,
      actorId: input.actorId,
      expectedRevision: snapshot.objective.revision,
    });
    return;
  }
  if (input.workflowState !== "completed") return;
  try {
    input.authority.completeObjective(input.objectiveId, {
      idempotencyKey: `workflow-completed:${input.objectiveId}:${input.workflowRevision}`,
      actorId: input.actorId,
      expectedRevision: snapshot.objective.revision,
    });
  } catch {
    // A workflow may reach its semantic terminal node while a background handle
    // or task projection is still settling. The next inspection retries safely.
  }
}

export function createAuthorityBoundWorkflowRuntime(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly authority: ExecutionAuthority;
}): WorkflowRuntimePort {
  const inspectAndProject = (args: {
    readonly ctx: WorkflowSpawnRequest["ctx"];
    readonly parent?: ParentExecutionContext;
  }): WorkflowAuthoritySnapshot => {
    const snapshot = input.workflow.inspect(args);
    const objectiveId = ensureObjective({
      authority: input.authority,
      ctx: args.ctx,
      ...(args.parent ? { parent: args.parent } : {}),
    });
    if (objectiveId) {
      const actorId = actorIdFor(args.ctx, args.parent);
      input.authority.syncLegalActions(objectiveId, legalActions(snapshot), actorId);
      reconcileTerminalObjective({
        authority: input.authority,
        objectiveId,
        actorId,
        workflowState: snapshot.workflow.currentState,
        workflowRevision: snapshot.workflow.revision,
      });
    }
    return snapshot;
  };

  return {
    inspect(args) {
      return inspectAndProject(args);
    },

    async spawn(request): Promise<WorkflowSpawnResult> {
      const authoritySnapshot = inspectAndProject({
        ctx: request.ctx,
        ...(request.parent ? { parent: request.parent } : {}),
      });
      const option = authoritySnapshot.workflow.options.find(
        (candidate) => candidate.agent === request.agent,
      );
      if (!option) return input.workflow.spawn(request);

      const objectiveId = ensureObjective({
        authority: input.authority,
        ctx: request.ctx,
        ...(request.parent ? { parent: request.parent } : {}),
      });
      if (!objectiveId) return input.workflow.spawn(request);
      const objective = input.authority.inspectObjective(objectiveId);
      const parentHandleId = request.parent?.kind === "child" ? request.parent.handleId : undefined;
      const parentNodeId = parentHandleId
        ? objective.handles.find((handle) => handle.id === parentHandleId)?.nodeId
        : objective.objective.rootNodeId;

      const execution = await input.workflow.spawn(request);
      if (!execution.ok) return execution;

      let current = input.authority.inspectObjective(objectiveId);
      const node = input.authority.createNode(
        {
          objectiveId,
          ...(parentNodeId ? { parentNodeId } : {}),
          actionId: option.transitionId,
          purpose: option.purpose,
          assignment: request.task,
          requirements: request.requirements ?? [],
          role: option.role,
          outputSchemaId: option.outputSchemaId,
        },
        {
          idempotencyKey: `workflow-node:${execution.record.id}`,
          actorId: actorIdFor(request.ctx, request.parent),
          expectedRevision: current.objective.revision,
        },
      );
      current = input.authority.inspectObjective(objectiveId);
      input.authority.registerHandle(
        {
          id: execution.record.id,
          objectiveId,
          nodeId: node.id,
          mode: request.mode ?? "await",
          ...(execution.record.subagentId ? { childRunId: execution.record.subagentId } : {}),
        },
        {
          idempotencyKey: `workflow-handle:${execution.record.id}`,
          actorId: actorIdFor(request.ctx, request.parent),
          expectedRevision: current.objective.revision,
        },
      );
      current = input.authority.inspectObjective(objectiveId);
      input.authority.updateHandleRuntime(
        execution.record.id,
        {
          runtimeState: runtimeState(execution.record.status),
          ...(execution.record.subagentId ? { childRunId: execution.record.subagentId } : {}),
          ...(execution.record.errors ? { errors: execution.record.errors } : {}),
        },
        {
          idempotencyKey: `workflow-runtime:${execution.record.id}:${execution.record.status}`,
          actorId: "runtime-supervisor",
          expectedRevision: current.objective.revision,
        },
      );

      if (execution.record.status === "completed") {
        current = input.authority.inspectObjective(objectiveId);
        input.authority.submitResult(execution.record.id, execution.record.value, {
          idempotencyKey: `workflow-submit:${execution.record.id}`,
          actorId: request.agent,
          expectedRevision: current.objective.revision,
        });
        current = input.authority.inspectObjective(objectiveId);
        input.authority.decideAcceptance(
          execution.record.id,
          { outcome: "accepted", value: execution.record.value },
          {
            idempotencyKey: `workflow-accept:${execution.record.id}`,
            actorId: "acceptance-engine",
            expectedRevision: current.objective.revision,
          },
        );
      }

      return {
        ok: true,
        transition: execution.transition,
        record: handleResult(execution.record),
      };
    },
  };
}
