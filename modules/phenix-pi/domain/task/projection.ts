import { isTerminalRunState } from "../run/invariants.ts";
import type { DomainEvent, TaskRunAssignmentData } from "../run/events.ts";
import type { RunRecord, RunState } from "../run/model.ts";
import type { RunProjection } from "../run/reducer.ts";
import type { LocalTaskId, RunId, TaskId, TaskState } from "../shared.ts";
import type { LocalTask } from "./local-task.ts";

export interface TaskRunAssignment {
  readonly runId: RunId;
  readonly title: string;
  readonly state: RunState;
  readonly requestedAt: string;
}

export interface ExecutionTaskNode {
  readonly kind: "execution";
  readonly id: `run:${RunId}`;
  readonly runId: RunId;
  readonly title: string;
  readonly ownState: TaskState;
  readonly effectiveState: TaskState;
  readonly progress: readonly string[];
  readonly children: readonly LocalTaskNode[];
}

export interface LocalTaskNode extends LocalTask {
  readonly effectiveState: TaskState;
  readonly progress: readonly string[];
  readonly assignedRuns: readonly TaskRunAssignment[];
  readonly children: readonly LocalTaskNode[];
}

export type TaskNode = ExecutionTaskNode | LocalTaskNode;

export interface TaskTree {
  readonly root: ExecutionTaskNode;
}

export interface DefinitionTitleLookup {
  title(definitionId: string): string | undefined;
}

function runOwnState(run: RunRecord): TaskState {
  if (run.state === "created") return "not_started";
  if (run.state === "completed") return "done";
  if (run.state === "failed" || run.state === "cancelled" || run.state === "orphaned") {
    return "failed";
  }
  return "wip";
}

export function effectiveTaskState(run: RunRecord, childTasks: readonly TaskNode[]): TaskState {
  if (run.state === "failed" || run.state === "cancelled" || run.state === "orphaned") {
    return "failed";
  }
  if (run.state !== "completed") return "wip";
  if (childTasks.some((task) => task.effectiveState === "failed")) return "failed";
  return childTasks.every((task) => task.effectiveState === "done") ? "done" : "wip";
}

export function projectTaskTree(
  projection: RunProjection,
  rootRunId: RunId,
  definitions: DefinitionTitleLookup,
): TaskTree {
  const root = projection.requireRun(rootRunId);
  if (root.parentId) throw new Error(`${rootRunId} is not a root run`);

  const tasks = [...projection.localTasks.values()]
    .filter((task) => projection.rootOf(task.ownerRunId) === rootRunId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<LocalTaskId | undefined, LocalTask[]>();
  for (const task of tasks) {
    if (task.parentId && !byId.has(task.parentId)) {
      throw new Error(`Task ${task.id} references unknown parent ${task.parentId}`);
    }
    const siblings = children.get(task.parentId) ?? [];
    siblings.push(task);
    children.set(task.parentId, siblings);
  }

  const assignments = taskAssignments(projection, rootRunId);
  const build = (task: LocalTask, ancestry: ReadonlySet<LocalTaskId>): LocalTaskNode => {
    if (ancestry.has(task.id)) throw new Error(`Task projection found cycle at ${task.id}`);
    const nextAncestry = new Set(ancestry).add(task.id);
    const childTasks = (children.get(task.id) ?? []).map((child) => build(child, nextAncestry));
    const assignedRuns = [...(assignments.get(task.id) ?? new Set<RunId>())]
      .map((runId) => projection.requireRun(runId))
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .map((run) => ({
        runId: run.id,
        title: definitions.title(run.definitionId) ?? run.definitionId,
        state: run.state,
        requestedAt: run.requestedAt,
      }));
    return {
      ...task,
      effectiveState: effectiveLocalTaskState(task, childTasks, assignedRuns),
      progress: projection.progress.get(task.id) ?? [],
      assignedRuns,
      children: childTasks,
    };
  };

  const rootChildren = (children.get(undefined) ?? []).map((task) => build(task, new Set()));
  const id = `run:${root.id}` as const;
  return {
    root: {
      kind: "execution",
      id,
      runId: root.id,
      title: "User objective",
      ownState: runOwnState(root),
      effectiveState: effectiveTaskState(root, rootChildren),
      progress: projection.progress.get(id) ?? [],
      children: rootChildren,
    },
  };
}

export function findTask(tree: TaskTree, taskId: TaskId): TaskNode | undefined {
  const pending: TaskNode[] = [tree.root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    if (current.id === taskId) return current;
    pending.push(...current.children);
  }
  return undefined;
}

export function tasksForRun(tree: TaskTree, runId: RunId): readonly LocalTaskNode[] {
  const result: LocalTaskNode[] = [];
  const pending: LocalTaskNode[] = [...tree.root.children];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    if (
      current.ownerRunId === runId ||
      current.assignedRuns.some((assignment) => assignment.runId === runId)
    ) {
      result.push(current);
    }
    pending.push(...current.children);
  }
  return result;
}

export function isExecutionSettled(node: ExecutionTaskNode): boolean {
  return isTerminalRunState(
    node.ownState === "done" ? "completed" : node.ownState === "failed" ? "failed" : "running",
  );
}

function taskAssignments(
  projection: RunProjection,
  rootRunId: RunId,
): ReadonlyMap<LocalTaskId, ReadonlySet<RunId>> {
  const assignments = new Map<LocalTaskId, Set<RunId>>();
  for (const event of projection.events) {
    if (event.rootRunId !== rootRunId) continue;
    if (event.type !== "task.run.assigned" && event.type !== "task.run.unassigned") continue;
    const data = assignmentData(event);
    const assigned = assignments.get(data.taskId) ?? new Set<RunId>();
    if (event.type === "task.run.assigned") assigned.add(data.runId);
    else assigned.delete(data.runId);
    if (assigned.size > 0) assignments.set(data.taskId, assigned);
    else assignments.delete(data.taskId);
  }
  return assignments;
}

function assignmentData(event: DomainEvent): TaskRunAssignmentData {
  const data = event.data as Partial<TaskRunAssignmentData>;
  if (typeof data.taskId !== "string" || typeof data.runId !== "string") {
    throw new Error(`Invalid ${event.type} event ${event.eventId}`);
  }
  return data as TaskRunAssignmentData;
}

function effectiveLocalTaskState(
  task: LocalTask,
  children: readonly LocalTaskNode[],
  assignedRuns: readonly TaskRunAssignment[],
): TaskState {
  if (task.state === "done" || task.state === "failed") return task.state;
  if (children.some((child) => child.effectiveState === "failed")) return "failed";
  if (
    task.state === "wip" ||
    assignedRuns.length > 0 ||
    children.some((child) => child.effectiveState !== "not_started")
  ) {
    return "wip";
  }
  return "not_started";
}
