import type { LocalTaskId, Outcome, RunId } from "../shared.ts";
import type { LocalTask } from "../task/local-task.ts";
import type { DomainEvent } from "./events.ts";
import { activeAttachedChildren, assertRunTransition, isTerminalRunState } from "./invariants.ts";
import type { RunRecord, RunState } from "./model.ts";

interface CycleProjection {
  readonly number: number;
  readonly state: "active" | "idle";
}

export class RunProjection {
  readonly runs = new Map<RunId, RunRecord>();
  readonly localTasks = new Map<LocalTaskId, LocalTask>();
  readonly events: DomainEvent[] = [];
  readonly submittedOutputs = new Map<RunId, unknown>();
  readonly cycles = new Map<RunId, CycleProjection>();
  readonly turnCounts = new Map<RunId, number>();
  readonly toolCallCounts = new Map<RunId, number>();
  readonly progress = new Map<string, readonly string[]>();
  readonly rootSequences = new Map<RunId, number>();
  readonly eventIds = new Set<string>();

  apply(event: DomainEvent): void {
    if (this.eventIds.has(event.eventId)) return;

    const expectedSequence = (this.rootSequences.get(event.rootRunId) ?? 0) + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Event sequence gap for ${event.rootRunId}: expected ${expectedSequence}, got ${event.sequence}`,
      );
    }

    if (event.type === "run.created") {
      this.applyCreated(event);
    } else {
      const current = this.requireRun(event.runId);
      if (event.revision !== current.revision + 1) {
        throw new Error(
          `Run revision gap for ${event.runId}: expected ${current.revision + 1}, got ${event.revision}`,
        );
      }
      this.applyExisting(event, current);
    }

    this.events.push(event);
    this.eventIds.add(event.eventId);
    this.rootSequences.set(event.rootRunId, event.sequence);
  }

  rootOf(runId: RunId): RunId {
    let current = this.requireRun(runId);
    const visited = new Set<RunId>();
    while (current.parentId) {
      if (visited.has(current.id)) throw new Error(`Run ancestry cycle at ${current.id}`);
      visited.add(current.id);
      current = this.requireRun(current.parentId);
    }
    return current.id;
  }

  childrenOf(parentId: RunId): readonly RunRecord[] {
    return [...this.runs.values()].filter((run) => run.parentId === parentId);
  }

  eventsFor(runId: RunId): readonly DomainEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }

  assertApplicable(events: readonly DomainEvent[]): void {
    const staged = this.fork();
    for (const event of events) staged.apply(event);
  }

  requireRun(runId: RunId): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run;
  }

  private applyCreated(event: DomainEvent): void {
    if (this.runs.has(event.runId)) throw new Error(`Run already exists: ${event.runId}`);
    if (event.revision !== 1) throw new Error(`A new run must start at revision 1`);

    const data = event.data as { readonly record: Omit<RunRecord, "revision" | "state"> };
    const record = data.record;
    if (record.id !== event.runId) throw new Error(`run.created identity mismatch`);
    if (record.parentId !== event.parentRunId) throw new Error(`run.created parent mismatch`);

    if (record.parentId) {
      const parent = this.requireRun(record.parentId);
      if (isTerminalRunState(parent.state) || parent.state === "completing") {
        throw new Error(`Cannot attach ${record.id} to ${parent.state} parent ${parent.id}`);
      }
      if (this.rootOf(parent.id) !== event.rootRunId) {
        throw new Error(`Run ${record.id} does not belong to ledger root ${event.rootRunId}`);
      }
    } else if (record.id !== event.rootRunId || record.kind !== "root") {
      throw new Error(`Only the root run may omit parentId`);
    }

    this.runs.set(record.id, { ...record, state: "created", revision: event.revision });
  }

  private applyExisting(event: DomainEvent, current: RunRecord): void {
    if (isTerminalRunState(current.state) && !event.type.startsWith("task.")) {
      throw new Error(`Run ${current.id} is terminal and cannot accept ${event.type}`);
    }
    let next: RunRecord = { ...current, revision: event.revision };

    switch (event.type) {
      case "run.state.changed": {
        const data = event.data as { readonly from: RunState; readonly to: RunState };
        if (data.from !== current.state) {
          throw new Error(
            `Stale transition for ${current.id}: expected ${current.state}, got ${data.from}`,
          );
        }
        assertRunTransition(current.state, data.to);
        next = { ...next, state: data.to };
        break;
      }
      case "run.model.resolved":
        next = {
          ...next,
          resolvedModel: (event.data as { readonly resolved: RunRecord["resolvedModel"] }).resolved,
        };
        break;
      case "run.pi.bound":
        next = {
          ...next,
          pi: (event.data as { readonly pi: NonNullable<RunRecord["pi"]> }).pi,
        };
        break;
      case "run.cycle.started": {
        const number = (event.data as { readonly number: number }).number;
        this.cycles.set(current.id, { number, state: "active" });
        break;
      }
      case "run.cycle.settled": {
        const number = (event.data as { readonly number: number }).number;
        this.cycles.set(current.id, { number, state: "idle" });
        break;
      }
      case "run.turn.ended":
        this.turnCounts.set(current.id, (this.turnCounts.get(current.id) ?? 0) + 1);
        break;
      case "run.tool.started":
        this.toolCallCounts.set(current.id, (this.toolCallCounts.get(current.id) ?? 0) + 1);
        break;
      case "run.output.submitted":
        this.submittedOutputs.set(current.id, (event.data as { readonly output: unknown }).output);
        break;
      case "run.completed":
        next = this.terminal(
          current,
          next,
          "completed",
          event.data as { outcome: Outcome<unknown> },
        );
        break;
      case "run.failed":
        next = this.terminal(current, next, "failed", event.data as { outcome: Outcome<unknown> });
        break;
      case "run.cancelled":
        next = this.terminal(
          current,
          next,
          "cancelled",
          event.data as { outcome: Outcome<unknown> },
        );
        break;
      case "run.orphaned":
        next = this.terminal(
          current,
          next,
          "orphaned",
          event.data as { outcome: Outcome<unknown> },
        );
        break;
      case "run.reparented": {
        const data = event.data as {
          readonly previousParentId: RunId;
          readonly newParentId: RunId;
          readonly ownership: "attached" | "detached";
        };
        if (current.parentId !== data.previousParentId)
          throw new Error(`Stale parent for ${current.id}`);
        const newParent = this.requireRun(data.newParentId);
        if (isTerminalRunState(newParent.state)) throw new Error(`Cannot reparent to terminal run`);
        let ancestor: RunRecord | undefined = newParent;
        while (ancestor) {
          if (ancestor.id === current.id)
            throw new Error(`Reparenting would create an ancestry cycle`);
          ancestor = ancestor.parentId ? this.requireRun(ancestor.parentId) : undefined;
        }
        next = { ...next, parentId: data.newParentId, ownership: data.ownership };
        break;
      }
      case "task.local.created": {
        const task = (event.data as { readonly task: LocalTask }).task;
        if (task.ownerRunId !== current.id) throw new Error(`Local task owner mismatch`);
        if (this.localTasks.has(task.id)) throw new Error(`Local task already exists: ${task.id}`);
        this.localTasks.set(task.id, task);
        break;
      }
      case "task.local.state.changed": {
        const data = event.data as {
          readonly taskId: LocalTaskId;
          readonly state: LocalTask["state"];
          readonly updatedAt: string;
        };
        const task = this.localTasks.get(data.taskId);
        if (!task || task.ownerRunId !== current.id)
          throw new Error(`Unknown local task ${data.taskId}`);
        this.localTasks.set(task.id, { ...task, state: data.state, updatedAt: data.updatedAt });
        break;
      }
      case "task.progress.appended": {
        const data = event.data as { readonly taskId: string; readonly message: string };
        this.progress.set(data.taskId, [...(this.progress.get(data.taskId) ?? []), data.message]);
        break;
      }
      default:
        break;
    }

    this.runs.set(current.id, next);
  }

  private terminal(
    current: RunRecord,
    next: RunRecord,
    state: "completed" | "failed" | "cancelled" | "orphaned",
    data: { readonly outcome: Outcome<unknown> },
  ): RunRecord {
    assertRunTransition(current.state, state);
    const expectedStatus =
      state === "completed" ? "success" : state === "cancelled" ? "cancelled" : "failure";
    if (data.outcome.status !== expectedStatus) {
      throw new Error(
        `Terminal outcome mismatch for ${current.id}: ${state} requires ${expectedStatus}`,
      );
    }
    const active = activeAttachedChildren(this.runs, current.id);
    if (active.length > 0) {
      throw new Error(
        `Run ${current.id} cannot become terminal with active attached children: ${active
          .map((child) => child.id)
          .join(", ")}`,
      );
    }
    return { ...next, state, outcome: data.outcome };
  }

  private fork(): RunProjection {
    const projection = new RunProjection();
    for (const [id, run] of this.runs) projection.runs.set(id, run);
    for (const [id, task] of this.localTasks) projection.localTasks.set(id, task);
    for (const [id, output] of this.submittedOutputs) {
      projection.submittedOutputs.set(id, output);
    }
    for (const [id, cycle] of this.cycles) projection.cycles.set(id, cycle);
    for (const [id, count] of this.turnCounts) projection.turnCounts.set(id, count);
    for (const [id, count] of this.toolCallCounts) projection.toolCallCounts.set(id, count);
    for (const [id, progress] of this.progress) projection.progress.set(id, progress);
    for (const [id, sequence] of this.rootSequences) {
      projection.rootSequences.set(id, sequence);
    }
    for (const eventId of this.eventIds) projection.eventIds.add(eventId);
    return projection;
  }
}
