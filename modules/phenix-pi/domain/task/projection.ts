import { isTerminalRunState } from "../run/invariants.ts";
import type { RunRecord } from "../run/model.ts";
import type { RunProjection } from "../run/reducer.ts";
import type { RunId, TaskId, TaskState } from "../shared.ts";
import type { LocalTask } from "./local-task.ts";

export interface ExecutionTaskNode {
  readonly kind: "execution";
  readonly id: `run:${RunId}`;
  readonly runId: RunId;
  readonly title: string;
  readonly ownState: TaskState;
  readonly effectiveState: TaskState;
  readonly progress: readonly string[];
  readonly children: readonly TaskNode[];
}

export interface LocalTaskNode extends LocalTask {
  readonly effectiveState: TaskState;
  readonly progress: readonly string[];
  readonly children: readonly [];
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

  const build = (run: RunRecord, ancestry: ReadonlySet<RunId>): ExecutionTaskNode => {
    if (ancestry.has(run.id)) throw new Error(`Task projection found run cycle at ${run.id}`);
    const nextAncestry = new Set(ancestry).add(run.id);
    const executionChildren = [...projection.childrenOf(run.id)]
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .map((child) => build(child, nextAncestry));
    const localChildren: LocalTaskNode[] = [...projection.localTasks.values()]
      .filter((task) => task.ownerRunId === run.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((task) => ({
        ...task,
        effectiveState: task.state,
        progress: projection.progress.get(task.id) ?? [],
        children: [],
      }));
    const children: TaskNode[] = [...executionChildren, ...localChildren];
    const id = `run:${run.id}` as const;
    return {
      kind: "execution",
      id,
      runId: run.id,
      title:
        run.kind === "root"
          ? "User objective"
          : (definitions.title(run.definitionId) ?? run.definitionId),
      ownState: runOwnState(run),
      effectiveState: effectiveTaskState(run, children),
      progress: projection.progress.get(id) ?? [],
      children,
    };
  };

  return { root: build(root, new Set()) };
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

export function isExecutionSettled(node: ExecutionTaskNode): boolean {
  return isTerminalRunState(
    node.ownState === "done" ? "completed" : node.ownState === "failed" ? "failed" : "running",
  );
}
