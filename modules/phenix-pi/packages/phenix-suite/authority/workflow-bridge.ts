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

function objectiveIdFor(
  ctx: WorkflowSpawnRequest["ctx"],
  parent?: ParentExecutionContext,
): string | undefined {
  if (parent?.kind === "child") return parent.contract.runtime.workflow.instanceId;
  const runtime = getSessionRuntime(ctx.sessionManager.getSessionId() ?? "default");
  return runtime.activeWorkflow?.instanceId;
}

function actorIdFor(
  ctx: WorkflowSpawnRequest["ctx"],
  parent?: ParentExecutionContext,
): string {
  if (parent?.kind === "child") return parent.contract.runtime.workflow.actorId;
  return getSessionRuntime(ctx.sessionManager.getSessionId() ?? "default").activeWorkflow?.actorId ?? "root";
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
    const policy = assurancePolicyFor({
      userTask: task,
      difficulty: workflow.difficulty,
      mutation: input.parent.contract.runtime.agent === "phenix.implementer" ? "local" : "none",
      deterministicChecksAvailable: input.parent.contract.verification.commands.length > 0,
      userRequestedRigor: input.parent.contract.verification.criticRequired ? "high" : "normal",
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
  const runtime = getSessionRuntime(sessionId);
  const active = runtime.activeWorkflow;
  if (!active) return undefined;
  const workflow = readWorkflowRecord(input.ctx.cwd, active.instanceId, active.actorId);
  if (!workflow) return undefined;
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
      input.authority.syncLegalActions(
        objectiveId,
        legalActions(snapshot),
        actorIdFor(args.ctx, args.parent),
      );
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
      const parentNodeId =
        request.parent?.kind === "child"
          ? objective.handles.find((handle) => handle.id === request.parent?.handleId)?.nodeId
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
