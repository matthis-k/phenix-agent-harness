import type { PhenixTaskService, TaskAuthority } from "@matthis-k/phenix-tasks/index.ts";

import type { ChildParentExecutionContext } from "../runtime/child-session-types.ts";
import type { ParentExecutionContext } from "../runtime/workflow-api-types.ts";
import type {
  WorkflowRuntimePort,
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
} from "../runtime/workflow-runtime-types.ts";

export interface TaskWorkflowBridge {
  readonly workflow: WorkflowRuntimePort;
  claimChildAuthority(parent: ChildParentExecutionContext): TaskAuthority;
  resolveParentAuthority(parent: ParentExecutionContext): TaskAuthority | undefined;
}

export function createTaskWorkflowBridge(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly tasks: PhenixTaskService;
}): TaskWorkflowBridge {
  const resolveParentAuthority = (parent: ParentExecutionContext): TaskAuthority | undefined => {
    if (parent.kind === "root") {
      return input.tasks.rootAuthorityForSession(parent.sessionId);
    }
    return input.tasks.authorityForActor(
      parent.contract.runtime.workflow.instanceId,
      parent.contract.runtime.workflow.actorId,
    );
  };

  const workflow: WorkflowRuntimePort = {
    inspect(request) {
      return input.workflow.inspect(request);
    },

    async spawn(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult> {
      const parent: ParentExecutionContext = request.parent ?? {
        kind: "root",
        sessionId: request.ctx.sessionManager.getSessionId() ?? "default",
        cwd: request.ctx.cwd,
        maximumDelegationDepth: Number.MAX_SAFE_INTEGER,
      };
      const authority = resolveParentAuthority(parent);
      if (!authority) {
        return {
          ok: false,
          message: "phenix_tasks: no task authority is bound to the workflow actor.",
          details: { code: "TASK_AUTHORITY_MISSING" },
        };
      }

      const pending = input.tasks.prepareDelegation(authority.token, {
        task: request.task,
        requirements: request.requirements,
      });
      const result = await input.workflow.spawn(request);
      if (!result.ok) {
        input.tasks.failDelegation(authority.token, pending.taskId);
      }
      return result;
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
