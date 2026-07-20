import { randomBytes, randomUUID } from "node:crypto";

export type TaskState = "not_started" | "wip" | "done";

export interface TaskLogEntry {
  readonly sequence: number;
  readonly taskId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly message: string;
  readonly timestamp: string;
}

export interface TaskRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly parentId: string | null;
  readonly position: number;
  readonly title: string;
  readonly description?: string;
  readonly explicitState: TaskState;
  readonly createdBySessionId: string;
  readonly assignedSessionId?: string;
  readonly startedBySessionId?: string;
  readonly completedBySessionId?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskNode extends TaskRecord {
  readonly effectiveState: TaskState;
  readonly children: readonly TaskNode[];
}

export interface TaskAuthority {
  readonly token: string;
  readonly workflowId: string;
  readonly scopeTaskId: string;
  readonly actorId: string;
  readonly sessionId: string;
}

export interface TaskSummary {
  readonly total: number;
  readonly notStarted: number;
  readonly wip: number;
  readonly done: number;
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
  readonly taskId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly kind: TaskEventKind;
  readonly timestamp: string;
  readonly task: TaskRecord;
}

interface CapabilityRecord extends TaskAuthority {}

interface WorkflowRecord {
  readonly id: string;
  readonly rootTaskId: string;
  readonly ownerSessionId: string;
  readonly rootActorId: string;
}

interface PendingDelegation {
  readonly id: string;
  readonly key: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly parentActorId: string;
}

export interface EnsureWorkflowInput {
  readonly workflowId: string;
  readonly ownerSessionId: string;
  readonly rootActorId: string;
  readonly title: string;
}

export interface DelegationClaimInput {
  readonly workflowId: string;
  readonly parentActorId: string;
  readonly childActorId: string;
  readonly childSessionId: string;
  readonly task: string;
  readonly requirements?: readonly string[];
}

export interface TaskMutation {
  readonly taskId: string;
  readonly title?: string;
  readonly description?: string;
  readonly state?: TaskState;
}

function now(): string {
  return new Date().toISOString();
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function delegationKey(input: {
  readonly workflowId: string;
  readonly parentActorId: string;
  readonly task: string;
  readonly requirements?: readonly string[];
}): string {
  return JSON.stringify([
    input.workflowId,
    input.parentActorId,
    input.task,
    [...(input.requirements ?? [])],
  ]);
}

function compactTitle(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117)}...`;
}

export class PhenixTaskService {
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly capabilities = new Map<string, CapabilityRecord>();
  private readonly rootAuthorityBySession = new Map<string, string>();
  private readonly authorityByActor = new Map<string, string>();
  private readonly pendingByKey = new Map<string, PendingDelegation[]>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly taskLogs = new Map<string, TaskLogEntry[]>();
  private sequence = 0;
  private logSequence = 0;

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ensureWorkflow(input: EnsureWorkflowInput): TaskAuthority {
    const existing = this.workflows.get(input.workflowId);
    if (existing) {
      const authority = this.rootAuthorityForSession(input.ownerSessionId);
      if (!authority) throw new Error(`Missing root task authority for ${input.workflowId}.`);
      return authority;
    }

    const timestamp = now();
    const rootTask: TaskRecord = {
      id: `task_${randomUUID()}`,
      workflowId: input.workflowId,
      parentId: null,
      position: 0,
      title: compactTitle(input.title) || "Phenix workflow",
      explicitState: "wip",
      createdBySessionId: input.ownerSessionId,
      assignedSessionId: input.ownerSessionId,
      startedBySessionId: input.ownerSessionId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tasks.set(rootTask.id, rootTask);
    this.workflows.set(input.workflowId, {
      id: input.workflowId,
      rootTaskId: rootTask.id,
      ownerSessionId: input.ownerSessionId,
      rootActorId: input.rootActorId,
    });

    const authority = this.issueAuthority({
      workflowId: input.workflowId,
      scopeTaskId: rootTask.id,
      actorId: input.rootActorId,
      sessionId: input.ownerSessionId,
    });
    this.rootAuthorityBySession.set(input.ownerSessionId, authority.token);
    this.authorityByActor.set(this.actorKey(input.workflowId, input.rootActorId), authority.token);
    this.emit("workflow.created", authority, rootTask);
    return authority;
  }

  workflowOwnerSessionId(workflowId: string): string | undefined {
    return this.workflows.get(workflowId)?.ownerSessionId;
  }

  rootAuthorityForSession(sessionId: string): TaskAuthority | undefined {
    const authorityToken = this.rootAuthorityBySession.get(sessionId);
    return authorityToken ? this.capabilities.get(authorityToken) : undefined;
  }

  authorityForActor(workflowId: string, actorId: string): TaskAuthority | undefined {
    const authorityToken = this.authorityByActor.get(this.actorKey(workflowId, actorId));
    return authorityToken ? this.capabilities.get(authorityToken) : undefined;
  }

  authorityForToken(authorityToken: string): TaskAuthority | undefined {
    return this.capabilities.get(authorityToken);
  }

  inspect(authorityToken: string): TaskNode {
    const authority = this.requireAuthority(authorityToken);
    return this.buildNode(authority.scopeTaskId);
  }

  summary(workflowId: string): TaskSummary {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return { total: 0, notStarted: 0, wip: 0, done: 0 };
    const root = this.buildNode(workflow.rootTaskId);
    const summary: TaskSummary = { total: 0, notStarted: 0, wip: 0, done: 0 };
    const visit = (node: TaskNode): void => {
      (summary as { total: number }).total += 1;
      if (node.effectiveState === "not_started") {
        (summary as { notStarted: number }).notStarted += 1;
      } else if (node.effectiveState === "wip") {
        (summary as { wip: number }).wip += 1;
      } else {
        (summary as { done: number }).done += 1;
      }
      node.children.forEach(visit);
    };
    visit(root);
    return summary;
  }

  addTask(
    authorityToken: string,
    input: { readonly parentId?: string; readonly title: string; readonly description?: string },
  ): TaskRecord {
    const authority = this.requireAuthority(authorityToken);
    const parentId = input.parentId ?? authority.scopeTaskId;
    this.assertOwned(authority, parentId);
    const siblings = this.childrenOf(parentId);
    const timestamp = now();
    const task: TaskRecord = {
      id: `task_${randomUUID()}`,
      workflowId: authority.workflowId,
      parentId,
      position: siblings.length,
      title: compactTitle(input.title),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      explicitState: "not_started",
      createdBySessionId: authority.sessionId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tasks.set(task.id, task);
    this.emit("task.created", authority, task);
    return task;
  }

  updateTask(authorityToken: string, mutation: TaskMutation): TaskRecord {
    const authority = this.requireAuthority(authorityToken);
    const current = this.requireTask(mutation.taskId);
    this.assertOwned(authority, current.id);

    if (mutation.state === "done") {
      const unfinished = this.childrenOf(current.id).filter(
        (child) => this.effectiveState(child.id) !== "done",
      );
      if (unfinished.length > 0) {
        throw new Error(
          `Task ${current.id} cannot be completed while child tasks remain unfinished.`,
        );
      }
    }
    if (mutation.state === "not_started") {
      const activeDescendant = this.descendantsOf(current.id).some(
        (task) => this.effectiveState(task.id) !== "not_started",
      );
      if (activeDescendant) {
        throw new Error(`Task ${current.id} cannot be reset while descendants are active.`);
      }
    }

    const timestamp = now();
    const nextState = mutation.state ?? current.explicitState;
    const updated: TaskRecord = {
      ...current,
      ...(mutation.title !== undefined ? { title: compactTitle(mutation.title) } : {}),
      ...(mutation.description !== undefined
        ? mutation.description.trim()
          ? { description: mutation.description.trim() }
          : { description: undefined }
        : {}),
      explicitState: nextState,
      ...(nextState === "wip"
        ? {
            assignedSessionId: current.assignedSessionId ?? authority.sessionId,
            startedBySessionId: authority.sessionId,
            completedBySessionId: undefined,
          }
        : {}),
      ...(nextState === "done"
        ? {
            assignedSessionId: current.assignedSessionId ?? authority.sessionId,
            startedBySessionId: current.startedBySessionId ?? authority.sessionId,
            completedBySessionId: authority.sessionId,
          }
        : {}),
      ...(nextState === "not_started"
        ? {
            assignedSessionId: undefined,
            startedBySessionId: undefined,
            completedBySessionId: undefined,
          }
        : {}),
      revision: current.revision + 1,
      updatedAt: timestamp,
    };
    this.tasks.set(updated.id, updated);
    const kind: TaskEventKind =
      mutation.state === "wip"
        ? "task.started"
        : mutation.state === "done"
          ? "task.completed"
          : "task.updated";
    this.emit(kind, authority, updated);
    return updated;
  }

  appendLog(
    authorityToken: string,
    input: { readonly taskId: string; readonly message: string },
  ): TaskLogEntry {
    const authority = this.requireAuthority(authorityToken);
    const task = this.requireTask(input.taskId);
    this.assertOwned(authority, task.id);
    const message = input.message.trim().replace(/\s+/g, " ");
    if (!message) throw new Error("Phenix task progress update cannot be empty.");
    if (message.length > 500) {
      throw new Error("Phenix task progress updates are limited to 500 characters.");
    }
    const entry: TaskLogEntry = {
      sequence: ++this.logSequence,
      taskId: task.id,
      actorId: authority.actorId,
      sessionId: authority.sessionId,
      message,
      timestamp: now(),
    };
    const entries = this.taskLogs.get(task.id) ?? [];
    entries.push(entry);
    this.taskLogs.set(task.id, entries);
    this.emit("task.logged", authority, task);
    return entry;
  }

  logsForTask(taskId: string): readonly TaskLogEntry[] {
    this.requireTask(taskId);
    return [...(this.taskLogs.get(taskId) ?? [])];
  }

  prepareDelegation(
    authorityToken: string,
    input: { readonly task: string; readonly requirements?: readonly string[] },
  ): PendingDelegation {
    const authority = this.requireAuthority(authorityToken);
    const delegated = this.addTask(authorityToken, {
      title: input.task,
      description: input.requirements?.length
        ? `Requirements: ${input.requirements.join("; ")}`
        : undefined,
    });
    const started = this.updateTask(authorityToken, { taskId: delegated.id, state: "wip" });
    const pending: PendingDelegation = {
      id: `delegation_${randomUUID()}`,
      key: delegationKey({
        workflowId: authority.workflowId,
        parentActorId: authority.actorId,
        task: input.task,
        requirements: input.requirements,
      }),
      workflowId: authority.workflowId,
      taskId: started.id,
      parentActorId: authority.actorId,
    };
    const queue = this.pendingByKey.get(pending.key) ?? [];
    queue.push(pending);
    this.pendingByKey.set(pending.key, queue);
    this.emit("task.delegated", authority, started);
    return pending;
  }

  claimDelegation(input: DelegationClaimInput): TaskAuthority {
    const key = delegationKey(input);
    const queue = this.pendingByKey.get(key) ?? [];
    const pending = queue.shift();
    if (queue.length === 0) this.pendingByKey.delete(key);
    else this.pendingByKey.set(key, queue);
    if (!pending) {
      throw new Error(
        `No pending task delegation exists for actor ${input.parentActorId} in ${input.workflowId}.`,
      );
    }

    const current = this.requireTask(pending.taskId);
    const authority = this.issueAuthority({
      workflowId: input.workflowId,
      scopeTaskId: pending.taskId,
      actorId: input.childActorId,
      sessionId: input.childSessionId,
    });
    this.authorityByActor.set(this.actorKey(input.workflowId, input.childActorId), authority.token);
    const updated: TaskRecord = {
      ...current,
      assignedSessionId: input.childSessionId,
      startedBySessionId: input.childSessionId,
      revision: current.revision + 1,
      updatedAt: now(),
    };
    this.tasks.set(updated.id, updated);
    this.emit("task.claimed", authority, updated);
    return authority;
  }

  failDelegation(authorityToken: string, taskId: string): TaskRecord {
    const authority = this.requireAuthority(authorityToken);
    const current = this.requireTask(taskId);
    this.assertOwned(authority, current.id);
    const updated: TaskRecord = {
      ...current,
      revision: current.revision + 1,
      updatedAt: now(),
    };
    this.tasks.set(updated.id, updated);
    this.emit("task.failed", authority, updated);
    return updated;
  }

  private issueAuthority(input: Omit<TaskAuthority, "token">): TaskAuthority {
    const authority: TaskAuthority = { ...input, token: token() };
    this.capabilities.set(authority.token, authority);
    return authority;
  }

  private requireAuthority(authorityToken: string): TaskAuthority {
    const authority = this.capabilities.get(authorityToken);
    if (!authority) throw new Error("Invalid or expired Phenix task capability.");
    return authority;
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown Phenix task: ${taskId}`);
    return task;
  }

  private assertOwned(authority: TaskAuthority, taskId: string): void {
    const task = this.requireTask(taskId);
    if (
      task.workflowId !== authority.workflowId ||
      !this.isDescendantOrSelf(task.id, authority.scopeTaskId)
    ) {
      throw new Error(`Task ${taskId} is outside the actor-owned subtree.`);
    }
  }

  private isDescendantOrSelf(taskId: string, ancestorId: string): boolean {
    let current: TaskRecord | undefined = this.tasks.get(taskId);
    while (current) {
      if (current.id === ancestorId) return true;
      current = current.parentId ? this.tasks.get(current.parentId) : undefined;
    }
    return false;
  }

  private childrenOf(parentId: string): readonly TaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => task.parentId === parentId)
      .sort((left, right) => left.position - right.position);
  }

  private descendantsOf(taskId: string): readonly TaskRecord[] {
    const descendants: TaskRecord[] = [];
    const visit = (parentId: string): void => {
      for (const child of this.childrenOf(parentId)) {
        descendants.push(child);
        visit(child.id);
      }
    };
    visit(taskId);
    return descendants;
  }

  private effectiveState(taskId: string): TaskState {
    const task = this.requireTask(taskId);
    if (task.explicitState === "done") return "done";
    if (task.explicitState === "wip") return "wip";
    return this.childrenOf(task.id).some((child) => this.effectiveState(child.id) !== "not_started")
      ? "wip"
      : "not_started";
  }

  private buildNode(taskId: string): TaskNode {
    const task = this.requireTask(taskId);
    return {
      ...task,
      effectiveState: this.effectiveState(task.id),
      children: this.childrenOf(task.id).map((child) => this.buildNode(child.id)),
    };
  }

  private emit(kind: TaskEventKind, authority: TaskAuthority, task: TaskRecord): void {
    const event: TaskEvent = {
      sequence: ++this.sequence,
      workflowId: task.workflowId,
      taskId: task.id,
      actorId: authority.actorId,
      sessionId: authority.sessionId,
      kind,
      timestamp: now(),
      task,
    };
    for (const listener of this.listeners) listener(event);
  }

  private actorKey(workflowId: string, actorId: string): string {
    return `${workflowId}:${actorId}`;
  }
}
