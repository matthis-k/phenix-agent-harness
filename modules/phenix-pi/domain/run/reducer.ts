import type { Objective } from "../objective/model.ts";
import type {
  CancelledOutcome,
  FailedOutcome,
  LocalTaskId,
  ObjectiveId,
  Outcome,
  RunId,
  SuccessfulOutcome,
} from "../shared.ts";
import type { LocalTask } from "../task/local-task.ts";
import type { DomainEvent } from "./events.ts";
import { activeAttachedChildren, assertRunTransition, isTerminalRunState } from "./invariants.ts";
import { normalizeSessionProfile, type RunRecord } from "./model.ts";
import {
  defaultActivity,
  type RunActivity,
  type RunActivityChangedData,
  type RunFact,
  type RunFactRecordedData,
  workflowNodeActivity,
} from "./observability.ts";

interface CycleProjection {
  readonly number: number;
  readonly state: "active" | "idle";
}

type ExistingDomainEvent = Exclude<DomainEvent, { readonly type: "run.created" }>;
type TerminalState = "completed" | "failed" | "cancelled" | "orphaned";
type TerminalOutcomeByState = {
  readonly completed: SuccessfulOutcome<unknown>;
  readonly failed: FailedOutcome;
  readonly cancelled: CancelledOutcome;
  readonly orphaned: FailedOutcome;
};

export class RunProjection {
  readonly runs = new Map<RunId, RunRecord>();
  readonly localTasks = new Map<LocalTaskId, LocalTask>();
  readonly progress = new Map<string, readonly string[]>();
  readonly objectives = new Map<ObjectiveId, Objective>();
  readonly objectiveFocuses = new Map<RunId, ObjectiveId>();
  readonly objectiveProgress = new Map<ObjectiveId, readonly string[]>();
  readonly events: DomainEvent[] = [];
  readonly submittedOutputs = new Map<RunId, unknown>();
  readonly cycles = new Map<RunId, CycleProjection>();
  readonly turnCounts = new Map<RunId, number>();
  readonly toolCallCounts = new Map<RunId, number>();
  readonly activities = new Map<RunId, RunActivity>();
  readonly facts: RunFact[] = [];
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

    this.projectObservability(event);
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

  factsFor(rootRunId: RunId): readonly RunFact[] {
    return this.facts.filter((fact) => fact.rootRunId === rootRunId);
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

  private applyCreated(event: DomainEvent<"run.created">): void {
    if (this.runs.has(event.runId)) throw new Error(`Run already exists: ${event.runId}`);
    if (event.revision !== 1) throw new Error(`A new run must start at revision 1`);

    const record = event.data.record;
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

  private applyExisting(event: ExistingDomainEvent, current: RunRecord): void {
    if (
      isTerminalRunState(current.state) &&
      !event.type.startsWith("task.") &&
      !event.type.startsWith("objective.")
    ) {
      throw new Error(`Run ${current.id} is terminal and cannot accept ${event.type}`);
    }
    let next: RunRecord = { ...current, revision: event.revision };

    switch (event.type) {
      case "run.state.changed": {
        if (event.data.from !== current.state) {
          throw new Error(
            `Stale transition for ${current.id}: expected ${current.state}, got ${event.data.from}`,
          );
        }
        assertRunTransition(current.state, event.data.to);
        next = { ...next, state: event.data.to };
        break;
      }
      case "run.profile.selected":
        if (current.kind !== "root") throw new Error(`Only root sessions own selectable profiles`);
        next = { ...next, profile: normalizeSessionProfile(event.data.profile) };
        break;
      case "run.model.resolved":
        next = { ...next, resolvedModel: event.data.resolved };
        break;
      case "run.model.observed":
        next = { ...next, observedModel: event.data.model };
        break;
      case "run.pi.bound":
        next = { ...next, pi: event.data.pi };
        break;
      case "run.cycle.started":
        this.cycles.set(current.id, { number: event.data.number, state: "active" });
        break;
      case "run.cycle.settled":
        this.cycles.set(current.id, { number: event.data.number, state: "idle" });
        break;
      case "run.turn.ended":
        this.turnCounts.set(current.id, (this.turnCounts.get(current.id) ?? 0) + 1);
        break;
      case "run.tool.started":
        this.toolCallCounts.set(current.id, (this.toolCallCounts.get(current.id) ?? 0) + 1);
        break;
      case "run.output.submitted":
        this.submittedOutputs.set(current.id, event.data.output);
        break;
      case "run.completed":
        next = this.terminal(current, next, "completed", event.data.outcome);
        break;
      case "run.failed":
        next = this.terminal(current, next, "failed", event.data.outcome);
        break;
      case "run.cancelled":
        next = this.terminal(current, next, "cancelled", event.data.outcome);
        break;
      case "run.orphaned":
        next = this.terminal(current, next, "orphaned", event.data.outcome);
        break;
      case "run.reparented": {
        if (current.parentId !== event.data.previousParentId) {
          throw new Error(`Stale parent for ${current.id}`);
        }
        const newParent = this.requireRun(event.data.newParentId);
        if (isTerminalRunState(newParent.state)) throw new Error(`Cannot reparent to terminal run`);
        let ancestor: RunRecord | undefined = newParent;
        while (ancestor) {
          if (ancestor.id === current.id) {
            throw new Error(`Reparenting would create an ancestry cycle`);
          }
          ancestor = ancestor.parentId ? this.requireRun(ancestor.parentId) : undefined;
        }
        next = {
          ...next,
          parentId: event.data.newParentId,
          ownership: event.data.ownership,
        };
        break;
      }
      case "task.local.created": {
        const { task } = event.data;
        if (task.ownerRunId !== current.id) throw new Error(`Local task owner mismatch`);
        if (this.localTasks.has(task.id)) throw new Error(`Local task already exists: ${task.id}`);
        this.localTasks.set(task.id, task);
        break;
      }
      case "task.local.state.changed": {
        const task = this.localTasks.get(event.data.taskId);
        if (!task || task.ownerRunId !== current.id) {
          throw new Error(`Unknown local task ${event.data.taskId}`);
        }
        this.localTasks.set(task.id, {
          ...task,
          state: event.data.state,
          updatedAt: event.data.updatedAt,
        });
        break;
      }
      case "task.progress.appended":
        this.progress.set(event.data.taskId, [
          ...(this.progress.get(event.data.taskId) ?? []),
          event.data.message,
        ]);
        break;
      case "objective.created": {
        const { objective } = event.data;
        if (objective.rootRunId !== event.rootRunId) throw new Error(`Objective root mismatch`);
        if (objective.createdByRunId !== current.id) throw new Error(`Objective creator mismatch`);
        if (this.objectives.has(objective.id)) {
          throw new Error(`Objective already exists: ${objective.id}`);
        }
        if (objective.parentObjectiveId) {
          const parent = this.objectives.get(objective.parentObjectiveId);
          if (!parent || parent.rootRunId !== objective.rootRunId) {
            throw new Error(`Unknown parent objective ${objective.parentObjectiveId}`);
          }
        }
        this.objectives.set(objective.id, objective);
        break;
      }
      case "objective.state.changed": {
        const objective = this.objectives.get(event.data.objectiveId);
        if (!objective || objective.rootRunId !== event.rootRunId) {
          throw new Error(`Unknown objective ${event.data.objectiveId}`);
        }
        this.objectives.set(objective.id, {
          ...objective,
          state: event.data.state,
          updatedAt: event.data.updatedAt,
        });
        break;
      }
      case "objective.focus.changed": {
        const objective = this.objectives.get(event.data.objectiveId);
        if (!objective || objective.rootRunId !== event.rootRunId) {
          throw new Error(`Unknown objective ${event.data.objectiveId}`);
        }
        this.objectiveFocuses.set(current.id, event.data.objectiveId);
        break;
      }
      case "objective.progress.appended": {
        const objective = this.objectives.get(event.data.objectiveId);
        if (!objective || objective.rootRunId !== event.rootRunId) {
          throw new Error(`Unknown objective ${event.data.objectiveId}`);
        }
        this.objectiveProgress.set(event.data.objectiveId, [
          ...(this.objectiveProgress.get(event.data.objectiveId) ?? []),
          event.data.message,
        ]);
        break;
      }
      case "run.activity.changed":
      case "run.fact.recorded":
      case "run.input.amended":
      case "run.output.rejected":
      case "run.budget.suspended":
      case "run.budget.resumed":
      case "attention.received":
      case "attention.routed":
      case "attention.routing.failed":
      case "attention.delivery.deferred":
      case "attention.delivered":
      case "attention.delivery.failed":
      case "workflow.node.entered":
      case "workflow.node.completed":
      case "workflow.transition.taken":
      case "workflow.checkpoint.saved":
        break;
      default:
        return assertNever(event);
    }

    this.runs.set(current.id, next);
  }

  private projectObservability(event: DomainEvent): void {
    const run = this.requireRun(event.runId);

    if (event.type === "run.activity.changed") {
      this.setActivity(event, event.data);
    } else if (event.type === "run.created" || event.type === "run.state.changed") {
      this.setActivity(event, defaultActivity(run));
    } else if (event.type === "workflow.node.entered") {
      this.setActivity(event, workflowNodeActivity(event.data.nodeId));
    }

    if (event.type === "run.fact.recorded") {
      this.appendFact(event, event.data);
      return;
    }

    const derived = derivedFact(event, run);
    if (derived) this.appendFact(event, derived);
  }

  private setActivity(event: DomainEvent, data: RunActivityChangedData): void {
    this.activities.set(event.runId, {
      rootRunId: event.rootRunId,
      runId: event.runId,
      phase: data.phase,
      summary: data.summary,
      ...(data.target ? { target: data.target } : {}),
      source: data.source,
      since: event.timestamp,
      sequence: event.sequence,
    });
  }

  private appendFact(event: DomainEvent, data: RunFactRecordedData): void {
    this.facts.push({
      id: event.eventId,
      rootRunId: event.rootRunId,
      runId: event.runId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      kind: data.kind,
      source: data.source,
      summary: data.summary,
      ...(data.subject ? { subject: data.subject } : {}),
      ...(data.details ? { details: data.details } : {}),
      provenance: { eventId: event.eventId, ...(data.provenance ?? {}) },
      reliability: data.reliability,
    });
  }

  private terminal<TState extends TerminalState>(
    current: RunRecord,
    next: RunRecord,
    state: TState,
    outcome: TerminalOutcomeByState[TState],
  ): RunRecord {
    assertRunTransition(current.state, state);
    const active = activeAttachedChildren(this.runs, current.id);
    if (active.length > 0) {
      throw new Error(
        `Run ${current.id} cannot become terminal with active attached children: ${active
          .map((child) => child.id)
          .join(", ")}`,
      );
    }
    return { ...next, state, outcome };
  }

  private fork(): RunProjection {
    const projection = new RunProjection();
    for (const [id, run] of this.runs) projection.runs.set(id, run);
    for (const [id, task] of this.localTasks) projection.localTasks.set(id, task);
    for (const [id, progress] of this.progress) projection.progress.set(id, progress);
    for (const [id, objective] of this.objectives) projection.objectives.set(id, objective);
    for (const [id, objectiveId] of this.objectiveFocuses) {
      projection.objectiveFocuses.set(id, objectiveId);
    }
    for (const [id, progress] of this.objectiveProgress) {
      projection.objectiveProgress.set(id, progress);
    }
    for (const [id, output] of this.submittedOutputs) projection.submittedOutputs.set(id, output);
    for (const [id, cycle] of this.cycles) projection.cycles.set(id, cycle);
    for (const [id, count] of this.turnCounts) projection.turnCounts.set(id, count);
    for (const [id, count] of this.toolCallCounts) projection.toolCallCounts.set(id, count);
    for (const [id, activity] of this.activities) projection.activities.set(id, activity);
    projection.facts.push(...this.facts);
    for (const [id, sequence] of this.rootSequences) projection.rootSequences.set(id, sequence);
    for (const eventId of this.eventIds) projection.eventIds.add(eventId);
    return projection;
  }
}

function derivedFact(event: DomainEvent, run: RunRecord): RunFactRecordedData | undefined {
  switch (event.type) {
    case "run.created":
      return {
        kind: run.parentId ? "child-started" : "run-started",
        source: "runtime",
        summary: `${run.parentId ? "Started" : "Opened"} ${run.definitionId}`,
        ...(run.parentId ? { provenance: { childRunId: run.id } } : {}),
        reliability: "observed",
      };
    case "workflow.node.entered":
      return {
        kind: "workflow-transition",
        source: "workflow",
        summary: `Entered workflow node ${event.data.nodeId}`,
        subject: event.data.nodeId,
        reliability: "observed",
      };
    case "workflow.transition.taken":
      return {
        kind: "workflow-transition",
        source: "workflow",
        summary: `Transitioned ${event.data.from} → ${event.data.to}`,
        subject: event.data.to,
        reliability: "observed",
      };
    case "run.completed":
      return terminalFact(run, "Completed", false);
    case "run.failed":
      return terminalFact(run, outcomeMessage(run.outcome) ?? "Failed", true);
    case "run.cancelled":
      return terminalFact(run, "Cancelled", true);
    case "run.orphaned":
      return terminalFact(run, "Orphaned", true);
    case "run.state.changed":
    case "run.profile.selected":
    case "run.model.resolved":
    case "run.model.observed":
    case "run.pi.bound":
    case "run.cycle.started":
    case "run.cycle.settled":
    case "run.turn.ended":
    case "run.tool.started":
    case "run.activity.changed":
    case "run.fact.recorded":
    case "run.input.amended":
    case "run.output.submitted":
    case "run.output.rejected":
    case "run.budget.suspended":
    case "run.budget.resumed":
    case "run.reparented":
    case "attention.received":
    case "attention.routed":
    case "attention.routing.failed":
    case "attention.delivery.deferred":
    case "attention.delivered":
    case "attention.delivery.failed":
    case "workflow.node.completed":
    case "workflow.checkpoint.saved":
    case "task.local.created":
    case "task.local.state.changed":
    case "task.progress.appended":
    case "objective.created":
    case "objective.state.changed":
    case "objective.focus.changed":
    case "objective.progress.appended":
      return undefined;
    default:
      return assertNever(event);
  }
}

function terminalFact(run: RunRecord, summary: string, error: boolean): RunFactRecordedData {
  return {
    kind: error ? "error-observed" : run.parentId ? "child-finished" : "run-state-changed",
    source: "runtime",
    summary: `${summary} · ${run.definitionId}`,
    ...(run.parentId ? { provenance: { childRunId: run.id } } : {}),
    reliability: "observed",
  };
}

function outcomeMessage(outcome: Outcome<unknown> | undefined): string | undefined {
  if (outcome?.status !== "failure") return undefined;
  return outcome.failure.message;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled domain event: ${JSON.stringify(value)}`);
}
