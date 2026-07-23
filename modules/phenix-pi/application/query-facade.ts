import type { DomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord, RunSnapshot } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { QueryFacade, RunTree, RunTreeNode, TaskFacade } from "./interfaces.ts";

export class QueryFacadeImpl implements QueryFacade {
  private readonly store: ExecutionStore;
  private readonly tasks: TaskFacade;

  constructor(store: ExecutionStore, tasks: TaskFacade) {
    this.store = store;
    this.tasks = tasks;
  }

  async runTree(rootRunId: RunId): Promise<RunTree> {
    const root = this.store.projection.requireRun(rootRunId);
    if (root.parentId) throw new Error(`${rootRunId} is not a root run`);
    const build = (run: RunRecord): RunTreeNode => ({
      run: this.snapshot(run),
      children: [...this.store.projection.childrenOf(run.id)]
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
        .map(build),
    });
    return { root: build(root) };
  }

  taskTree(rootRunId: RunId) {
    return this.tasks.tree(rootRunId);
  }

  async activeRuns(rootRunId: RunId): Promise<readonly RunSnapshot[]> {
    return [...this.store.projection.runs.values()]
      .filter(
        (run) =>
          this.store.projection.rootOf(run.id) === rootRunId && !isTerminalRunState(run.state),
      )
      .map((run) => this.snapshot(run));
  }

  async *events(rootRunId: RunId, afterSequence = 0): AsyncIterable<DomainEvent> {
    const queue = this.store.projection.events.filter(
      (event) => event.rootRunId === rootRunId && event.sequence > afterSequence,
    );
    let wake: (() => void) | undefined;
    let closed = false;
    const unsubscribe = this.store.events.subscribe((event) => {
      if (event.rootRunId !== rootRunId || event.sequence <= afterSequence) return;
      queue.push(event);
      wake?.();
      wake = undefined;
    });

    try {
      while (!closed) {
        const event = queue.shift();
        if (event) {
          afterSequence = event.sequence;
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      closed = true;
      unsubscribe();
    }
  }

  private snapshot(run: RunRecord): RunSnapshot {
    return {
      ...run,
      activeChildren: this.store.projection
        .childrenOf(run.id)
        .filter(
          (child) =>
            (child.ownership === "attached" || run.kind === "root") &&
            !isTerminalRunState(child.state),
        )
        .map((child) => child.id),
    };
  }
}
