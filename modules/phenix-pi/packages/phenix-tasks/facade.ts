import type {
  DelegationClaimInput,
  EnsureWorkflowInput,
  TaskEvent as InternalTaskEvent,
  TaskLogEntry as InternalTaskLogEntry,
  TaskNode as InternalTaskNode,
  TaskRecord as InternalTaskRecord,
  TaskAuthority,
  TaskState,
  TaskSummary,
} from "./core.ts";
import { PhenixTaskService } from "./core.ts";

export type TaskStatus = TaskState;

export interface TaskProgressUpdate {
  readonly sequence: number;
  readonly actorId: string;
  readonly sessionId: string;
  readonly message: string;
  readonly timestamp: string;
}

export interface TaskView {
  readonly uid: string;
  readonly name: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly ownStatus: TaskStatus;
  readonly assignedSessionId?: string;
  readonly startedBySessionId?: string;
  readonly completedBySessionId?: string;
  readonly log: readonly TaskProgressUpdate[];
}

export interface TaskTreeNode extends TaskView {
  readonly children: readonly TaskTreeNode[];
}

export interface TaskReference {
  readonly uid: string;
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly status: TaskStatus;
}

export interface TaskLogView extends TaskView {
  readonly path: string;
}

export type TaskEventKind =
  | "workflow.created"
  | "task.created"
  | "task.updated"
  | "task.started"
  | "task.completed"
  | "task.delegated"
  | "task.claimed"
  | "task.logged"
  | "task.failed";

export interface TaskEvent {
  readonly sequence: number;
  readonly workflowId: string;
  readonly taskUid: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly kind: TaskEventKind;
  readonly timestamp: string;
  readonly task: TaskView;
}

export interface TaskAddInput {
  readonly parentUid?: string;
  readonly name: string;
  readonly description?: string;
}

export interface TaskUpdateInput {
  readonly uid: string;
  readonly name?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
}

export interface PendingTaskDelegation {
  readonly uid: string;
  readonly taskUid: string;
}

export interface TaskRuntimeFacade {
  subscribe(listener: (event: TaskEvent) => void): () => void;
  ensureWorkflow(input: EnsureWorkflowInput): TaskAuthority;
  workflowOwnerSessionId(workflowId: string): string | undefined;
  rootAuthorityForSession(sessionId: string): TaskAuthority | undefined;
  authorityForActor(workflowId: string, actorId: string): TaskAuthority | undefined;
  authorityForToken(token: string): TaskAuthority | undefined;
  inspect(capability: string): TaskTreeNode;
  summary(workflowId: string): TaskSummary;
  add(capability: string, input: TaskAddInput): TaskView;
  update(capability: string, input: TaskUpdateInput): TaskView;
  appendLog(
    capability: string,
    input: { readonly uid: string; readonly message: string },
  ): TaskProgressUpdate;
  references(capability: string): readonly TaskReference[];
  readLog(capability: string, selector: string): TaskLogView;
  prepareDelegation(
    capability: string,
    input: { readonly task: string; readonly requirements?: readonly string[] },
  ): PendingTaskDelegation;
  claimDelegation(input: DelegationClaimInput): TaskAuthority;
  failDelegation(capability: string, taskUid: string): TaskView;
}

export type { EnsureWorkflowInput, TaskAuthority, TaskSummary };

function progress(entry: InternalTaskLogEntry): TaskProgressUpdate {
  return {
    sequence: entry.sequence,
    actorId: entry.actorId,
    sessionId: entry.sessionId,
    message: entry.message,
    timestamp: entry.timestamp,
  };
}

function view(service: PhenixTaskService, task: InternalTaskRecord, status: TaskStatus): TaskView {
  return {
    uid: task.id,
    name: task.title,
    ...(task.description ? { description: task.description } : {}),
    status,
    ownStatus: task.explicitState,
    ...(task.assignedSessionId ? { assignedSessionId: task.assignedSessionId } : {}),
    ...(task.startedBySessionId ? { startedBySessionId: task.startedBySessionId } : {}),
    ...(task.completedBySessionId ? { completedBySessionId: task.completedBySessionId } : {}),
    log: service.logsForTask(task.id).map(progress),
  };
}

function tree(service: PhenixTaskService, node: InternalTaskNode): TaskTreeNode {
  return {
    ...view(service, node, node.effectiveState),
    children: node.children.map((child) => tree(service, child)),
  };
}

function flatten(root: TaskTreeNode): readonly { node: TaskTreeNode; path: string }[] {
  const rows: Array<{ node: TaskTreeNode; path: string }> = [];
  const visit = (node: TaskTreeNode, path: string): void => {
    rows.push({ node, path });
    for (const child of node.children) visit(child, `${path}.${child.name}`);
  };
  visit(root, root.name);
  return rows;
}

function resolve(root: TaskTreeNode, selector: string): { node: TaskTreeNode; path: string } {
  const normalized = selector.trim();
  if (!normalized) throw new Error("A Phenix task UID or exact task path is required.");
  const rows = flatten(root);
  const byUid = rows.filter(({ node }) => node.uid === normalized);
  if (byUid.length === 1) return byUid[0];

  const relativeRows = rows.map((row) => ({
    ...row,
    relativePath: row.path === root.name ? root.name : row.path.slice(root.name.length + 1),
  }));
  const byPath = relativeRows.filter(
    (row) => row.path === normalized || row.relativePath === normalized,
  );
  if (byPath.length === 1) return byPath[0];
  if (byPath.length > 1) {
    throw new Error(`Ambiguous Phenix task path: ${normalized}. Use the task UID.`);
  }
  throw new Error(`Unknown Phenix task UID or exact path: ${normalized}`);
}

class TaskRuntimeFacadeImpl implements TaskRuntimeFacade {
  private readonly service: PhenixTaskService;

  constructor(service: PhenixTaskService) {
    this.service = service;
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    return this.service.subscribe((event: InternalTaskEvent) => {
      const ownerSessionId = this.service.workflowOwnerSessionId(event.workflowId);
      const rootAuthority = ownerSessionId
        ? this.service.rootAuthorityForSession(ownerSessionId)
        : undefined;
      const matching = rootAuthority
        ? flatten(tree(this.service, this.service.inspect(rootAuthority.token))).find(
            ({ node: item }) => item.uid === event.taskId,
          )
        : undefined;
      listener({
        sequence: event.sequence,
        workflowId: event.workflowId,
        taskUid: event.taskId,
        actorId: event.actorId,
        sessionId: event.sessionId,
        kind: event.kind,
        timestamp: event.timestamp,
        task: matching?.node ?? view(this.service, event.task, event.task.explicitState),
      });
    });
  }

  ensureWorkflow(input: EnsureWorkflowInput): TaskAuthority {
    return this.service.ensureWorkflow(input);
  }

  workflowOwnerSessionId(workflowId: string): string | undefined {
    return this.service.workflowOwnerSessionId(workflowId);
  }

  rootAuthorityForSession(sessionId: string): TaskAuthority | undefined {
    return this.service.rootAuthorityForSession(sessionId);
  }

  authorityForActor(workflowId: string, actorId: string): TaskAuthority | undefined {
    return this.service.authorityForActor(workflowId, actorId);
  }

  authorityForToken(token: string): TaskAuthority | undefined {
    return this.service.authorityForToken(token);
  }

  inspect(capability: string): TaskTreeNode {
    return tree(this.service, this.service.inspect(capability));
  }

  summary(workflowId: string): TaskSummary {
    return this.service.summary(workflowId);
  }

  add(capability: string, input: TaskAddInput): TaskView {
    const record = this.service.addTask(capability, {
      ...(input.parentUid ? { parentId: input.parentUid } : {}),
      title: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    return view(this.service, record, record.explicitState);
  }

  update(capability: string, input: TaskUpdateInput): TaskView {
    const record = this.service.updateTask(capability, {
      taskId: input.uid,
      ...(input.name !== undefined ? { title: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { state: input.status } : {}),
    });
    const root = this.inspect(capability);
    return resolve(root, record.id).node;
  }

  appendLog(
    capability: string,
    input: { readonly uid: string; readonly message: string },
  ): TaskProgressUpdate {
    return progress(
      this.service.appendLog(capability, { taskId: input.uid, message: input.message }),
    );
  }

  references(capability: string): readonly TaskReference[] {
    return flatten(this.inspect(capability)).map(({ node, path }) => ({
      uid: node.uid,
      path,
      name: node.name,
      ...(node.description ? { description: node.description } : {}),
      status: node.status,
    }));
  }

  readLog(capability: string, selector: string): TaskLogView {
    const match = resolve(this.inspect(capability), selector);
    return { ...match.node, path: match.path };
  }

  prepareDelegation(
    capability: string,
    input: { readonly task: string; readonly requirements?: readonly string[] },
  ): PendingTaskDelegation {
    const pending = this.service.prepareDelegation(capability, input);
    return { uid: pending.id, taskUid: pending.taskId };
  }

  claimDelegation(input: DelegationClaimInput): TaskAuthority {
    return this.service.claimDelegation(input);
  }

  failDelegation(capability: string, taskUid: string): TaskView {
    const record = this.service.failDelegation(capability, taskUid);
    return view(this.service, record, record.explicitState);
  }
}

export function createTaskRuntimeFacade(): TaskRuntimeFacade {
  return new TaskRuntimeFacadeImpl(new PhenixTaskService());
}
