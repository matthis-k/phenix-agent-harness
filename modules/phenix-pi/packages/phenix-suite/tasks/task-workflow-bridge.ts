import type { TaskAuthority, TaskRuntimeFacade } from "@matthis-k/phenix-tasks/index.ts";

import { executionAuthorityForProject } from "../authority/registry.ts";
import { registerAuthorityTaskProjection } from "../authority/task-projection.ts";
import { createAuthorityBoundWorkflowRuntime } from "../authority/workflow-bridge.ts";
import type { ChildParentExecutionContext } from "../runtime/child-session-types.ts";
import type { ParentExecutionContext } from "../runtime/workflow-api-types.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowRuntimePort,
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
} from "../runtime/workflow-runtime-types.ts";
import { resolveWorkflowSpawnRequest } from "../subagents/workflow-assignment.ts";

export interface TaskWorkflowBridge {
  readonly workflow: WorkflowRuntimePort;
  claimChildAuthority(parent: ChildParentExecutionContext): TaskAuthority;
  resolveParentAuthority(parent: ParentExecutionContext): TaskAuthority | undefined;
}

function compactDiagnostic(message: string): string {
  const normalized = message.trim().replace(/\s+/g, " ");
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}

function appendDiagnostic(
  tasks: TaskRuntimeFacade,
  authority: TaskAuthority,
  taskUid: string,
  message: string,
): void {
  try {
    tasks.appendLog(authority.token, { uid: taskUid, message: compactDiagnostic(message) });
  } catch {
    // Diagnostics must never alter workflow execution semantics.
  }
}

function failureDiagnostic(result: Extract<WorkflowSpawnResult, { readonly ok: false }>): string {
  const code = typeof result.details?.code === "string" ? result.details.code : undefined;
  const handleId =
    typeof result.details?.handleId === "string" ? result.details.handleId : undefined;
  const status = typeof result.details?.status === "string" ? result.details.status : undefined;
  const errors = Array.isArray(result.details?.errors)
    ? result.details.errors.filter((value): value is string => typeof value === "string")
    : [];
  const context = [
    code ? `code=${code}` : undefined,
    handleId ? `handle=${handleId}` : undefined,
    status ? `status=${status}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(", ");
  const suffix = errors.length > 0 ? ` Errors: ${errors.join(" | ")}` : "";
  return `Workflow delegation failed${context ? ` (${context})` : ""}: ${result.message}${suffix}`;
}

function reconcileTerminalRootTask(input: {
  readonly tasks: TaskRuntimeFacade;
  readonly authority: TaskAuthority;
  readonly snapshot: WorkflowAuthoritySnapshot;
}): void {
  if (input.snapshot.source !== "root" || input.snapshot.workflow.options.length > 0) return;

  const root = input.tasks.inspect(input.authority.token);
  if (root.ownStatus === "done") return;

  try {
    input.tasks.update(input.authority.token, { uid: root.uid, status: "done" });
  } catch {
    // A terminal workflow may still have an active background child. The next
    // workflow inspection or awaited completion will reconcile the root once
    // every owned descendant is done.
  }
}

function prepareRuntimeInternalDelegation(
  tasks: TaskRuntimeFacade,
  parent: ChildParentExecutionContext,
): void {
  if (parent.taskAuthoritySource !== "runtime-internal") return;

  const workflowId = parent.contract.runtime.workflow.instanceId;
  const actorId = parent.contract.runtime.workflow.actorId;
  const parentActorId = parent.contract.runtime.workflow.parentActorId;
  if (!parentActorId) {
    throw new Error(`Runtime-internal child task authority ${actorId} has no parent workflow actor.`);
  }

  const parentAuthority = tasks.authorityForActor(workflowId, parentActorId);
  if (!parentAuthority) {
    throw new Error(
      `Runtime-internal child task authority cannot resolve parent actor ${parentActorId} in ${workflowId}.`,
    );
  }

  tasks.prepareDelegation(parentAuthority.token, {
    task: parent.contract.assignment.task,
    requirements: parent.contract.assignment.requirements,
  });
}

export function createTaskWorkflowBridge(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly tasks: TaskRuntimeFacade;
}): TaskWorkflowBridge {
  const projectedAuthorities = new WeakSet<object>();
  const authorityWorkflow = (request: { readonly ctx: WorkflowSpawnRequest["ctx"] }) => {
    const authority = executionAuthorityForProject(request.ctx.cwd);
    if (!projectedAuthorities.has(authority)) {
      registerAuthorityTaskProjection({ tasks: input.tasks, authority });
      projectedAuthorities.add(authority);
    }
    return createAuthorityBoundWorkflowRuntime({ workflow: input.workflow, authority });
  };

  const resolveParentAuthority = (parent: ParentExecutionContext): TaskAuthority | undefined => {
    if (parent.kind === "root") {
      return input.tasks.rootAuthorityForSession(parent.sessionId);
    }
    return input.tasks.authorityForActor(
      parent.contract.runtime.workflow.instanceId,
      parent.contract.runtime.workflow.actorId,
    );
  };

  const rootParent = (request: {
    readonly ctx: WorkflowSpawnRequest["ctx"];
    readonly parent?: ParentExecutionContext;
  }): ParentExecutionContext =>
    request.parent ?? {
      kind: "root",
      sessionId: request.ctx.sessionManager.getSessionId() ?? "default",
      cwd: request.ctx.cwd,
      maximumDelegationDepth: Number.MAX_SAFE_INTEGER,
    };

  const workflow: WorkflowRuntimePort = {
    inspect(request) {
      const projectedWorkflow = authorityWorkflow(request);
      const snapshot = projectedWorkflow.inspect(request);
      const authority = resolveParentAuthority(rootParent(request));
      if (authority) reconcileTerminalRootTask({ tasks: input.tasks, authority, snapshot });
      return snapshot;
    },

    async spawn(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult> {
      const parent = rootParent(request);
      const authority = resolveParentAuthority(parent);
      if (!authority) {
        return {
          ok: false,
          message: "phenix_tasks: no task authority is bound to the workflow actor.",
          details: { code: "TASK_AUTHORITY_MISSING" },
        };
      }

      const projectedWorkflow = authorityWorkflow(request);
      const snapshot = projectedWorkflow.inspect(request);
      const resolvedRequest = resolveWorkflowSpawnRequest(snapshot, request);
      const pending = input.tasks.prepareDelegation(authority.token, {
        task: resolvedRequest.task,
        requirements: resolvedRequest.requirements,
      });
      appendDiagnostic(
        input.tasks,
        authority,
        pending.taskUid,
        `Delegation requested: agent=${resolvedRequest.agent}, mode=${resolvedRequest.mode ?? "await"}.`,
      );

      try {
        const result = await projectedWorkflow.spawn(resolvedRequest);
        if (!result.ok) {
          appendDiagnostic(input.tasks, authority, pending.taskUid, failureDiagnostic(result));
          input.tasks.failDelegation(authority.token, pending.taskUid);
          return result;
        }

        appendDiagnostic(
          input.tasks,
          authority,
          pending.taskUid,
          `Delegation started: handle=${result.record.id}, status=${result.record.status}, transition=${result.transition.fromNodeId}->${result.transition.toNodeId}.`,
        );
        const postSpawn = projectedWorkflow.inspect({
          ctx: request.ctx,
          ...(request.parent ? { parent: request.parent } : {}),
        });
        reconcileTerminalRootTask({ tasks: input.tasks, authority, snapshot: postSpawn });
        return result;
      } catch (error) {
        appendDiagnostic(
          input.tasks,
          authority,
          pending.taskUid,
          `Workflow delegation threw before returning a result: ${error instanceof Error ? error.message : String(error)}`,
        );
        input.tasks.failDelegation(authority.token, pending.taskUid);
        throw error;
      }
    },
  };

  return {
    workflow,
    resolveParentAuthority,
    claimChildAuthority(parent) {
      const workflowId = parent.contract.runtime.workflow.instanceId;
      const actorId = parent.contract.runtime.workflow.actorId;
      const existing = input.tasks.authorityForActor(workflowId, actorId);
      if (existing) return existing;

      prepareRuntimeInternalDelegation(input.tasks, parent);
      const parentActorId = parent.contract.runtime.workflow.parentActorId;
      if (!parentActorId) {
        throw new Error(`Child task authority ${actorId} has no parent workflow actor.`);
      }
      return input.tasks.claimDelegation({
        workflowId,
        parentActorId,
        childActorId: actorId,
        childSessionId: parent.childRunId,
        task: parent.contract.assignment.task,
        requirements: parent.contract.assignment.requirements,
      });
    },
  };
}
