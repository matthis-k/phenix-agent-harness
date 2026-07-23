import type { RunRecord, RunState } from "./model.ts";

const transitions: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  created: new Set(["starting", "running", "failed", "cancelled", "orphaned"]),
  starting: new Set(["running", "failed", "cancelled", "orphaned"]),
  running: new Set(["waiting", "completing", "completed", "failed", "cancelled", "orphaned"]),
  waiting: new Set(["running", "completing", "failed", "cancelled", "orphaned"]),
  completing: new Set(["running", "completed", "failed", "cancelled", "orphaned"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  orphaned: new Set(),
};

export function isTerminalRunState(state: RunState): boolean {
  return (
    state === "completed" || state === "failed" || state === "cancelled" || state === "orphaned"
  );
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (from === to) return;
  if (!transitions[from].has(to)) {
    throw new Error(`Illegal run transition: ${from} -> ${to}`);
  }
}

export function activeAttachedChildren(
  runs: ReadonlyMap<string, RunRecord>,
  parentId: string,
): readonly RunRecord[] {
  const parent = runs.get(parentId);
  return [...runs.values()].filter(
    (run) =>
      run.parentId === parentId &&
      (run.ownership === "attached" || parent?.kind === "root") &&
      !isTerminalRunState(run.state),
  );
}
