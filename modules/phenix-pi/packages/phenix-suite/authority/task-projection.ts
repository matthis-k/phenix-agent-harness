import type { TaskRuntimeFacade, TaskTreeNode } from "@matthis-k/phenix-tasks/index.ts";
import type { ExecutionAuthority } from "./service.ts";
import type { ObjectiveRecord } from "./types.ts";

function locate(
  root: TaskTreeNode,
  uid: string,
  parentUid?: string,
): { readonly task: TaskTreeNode; readonly parentUid?: string } | undefined {
  if (root.uid === uid) return { task: root, ...(parentUid ? { parentUid } : {}) };
  for (const child of root.children) {
    const match = locate(child, uid, root.uid);
    if (match) return match;
  }
  return undefined;
}

export function registerAuthorityTaskProjection(input: {
  readonly tasks: TaskRuntimeFacade;
  readonly authority: ExecutionAuthority;
}): () => void {
  return input.tasks.subscribe((event) => {
    let objective: ObjectiveRecord;
    try {
      objective = input.authority.inspectObjective(event.workflowId).objective;
    } catch {
      return;
    }
    const ownerSessionId = input.tasks.workflowOwnerSessionId(event.workflowId);
    const taskAuthority = ownerSessionId
      ? input.tasks.rootAuthorityForSession(ownerSessionId)
      : undefined;
    if (!taskAuthority) return;
    const root = input.tasks.inspect(taskAuthority.token);
    if (event.taskUid === root.uid) return;
    const match = locate(root, event.taskUid);
    if (!match) return;
    input.authority.projectTask({
      objectiveId: objective.id,
      taskUid: match.task.uid,
      ...(match.parentUid ? { parentTaskUid: match.parentUid } : {}),
      title: match.task.name,
      ...(match.task.description ? { description: match.task.description } : {}),
      status: match.task.status,
      actorId: event.actorId,
    });
  });
}
