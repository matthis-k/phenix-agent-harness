import type { DomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord, RunSnapshot } from "../domain/run/model.ts";
import {
  type ActivityPhase,
  defaultActivity,
  type RunActivity,
  type RunFact,
} from "../domain/run/observability.ts";
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
    const build = (run: RunRecord): RunTreeNode => {
      const activity = this.activityFor(run);
      return {
        run: this.snapshot(run),
        ...(activity ? { activity } : {}),
        children: [...this.store.projection.childrenOf(run.id)]
          .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
          .map(build),
      };
    };
    return { root: build(root) };
  }

  async facts(rootRunId: RunId, limit?: number) {
    this.store.projection.requireRun(rootRunId);
    const facts = this.store.projection.factsFor(rootRunId);
    if (limit === undefined || !Number.isFinite(limit)) return facts;
    const bounded = Math.max(0, Math.floor(limit));
    return bounded === 0 ? [] : facts.slice(-bounded);
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

  private activityFor(run: RunRecord): RunActivity | undefined {
    const activity = this.store.projection.activities.get(run.id);
    if (isTerminalRunState(run.state) || run.state === "completing" || run.state === "waiting") {
      const fallback = defaultActivity(run);
      return {
        rootRunId: this.store.projection.rootOf(run.id),
        runId: run.id,
        ...fallback,
        since: activity?.since ?? run.requestedAt,
        sequence: activity?.sequence ?? 0,
      };
    }
    if (!activity || activity.target || activity.source === "reported") return activity;

    const lastFact = [...this.store.projection.facts]
      .reverse()
      .find((fact) => fact.runId === run.id && fact.subject && isMeaningfulActivityFact(fact));
    if (!lastFact?.subject) return activity;
    return {
      ...activity,
      phase: phaseForFact(lastFact),
      summary: lastFact.summary,
      target: lastFact.subject,
      source: "derived",
      since: lastFact.timestamp,
      sequence: lastFact.sequence,
    };
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

function isMeaningfulActivityFact(fact: RunFact): boolean {
  return [
    "file-read",
    "search-performed",
    "file-changed",
    "command-finished",
    "test-result",
    "child-started",
    "error-observed",
  ].includes(fact.kind);
}

function phaseForFact(fact: RunFact): ActivityPhase {
  return fact.kind === "file-read" || fact.kind === "search-performed"
    ? "exploring"
    : fact.kind === "file-changed"
      ? "editing"
      : fact.kind === "test-result"
        ? "testing"
        : fact.kind === "child-started"
          ? "delegating"
          : "analyzing";
}
