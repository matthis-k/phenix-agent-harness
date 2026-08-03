import {
  type DomainEvent,
  type DomainEventType,
} from "./events.ts";
import { runId } from "../shared.ts";

const DOMAIN_EVENT_TYPES = {
  "run.created": true,
  "run.state.changed": true,
  "run.profile.selected": true,
  "run.model.resolved": true,
  "run.model.observed": true,
  "run.pi.bound": true,
  "run.cycle.started": true,
  "run.cycle.settled": true,
  "run.turn.ended": true,
  "run.tool.started": true,
  "run.activity.changed": true,
  "run.fact.recorded": true,
  "run.input.amended": true,
  "run.output.submitted": true,
  "run.output.rejected": true,
  "run.budget.suspended": true,
  "run.budget.resumed": true,
  "run.completed": true,
  "run.failed": true,
  "run.cancelled": true,
  "run.orphaned": true,
  "run.reparented": true,
  "attention.received": true,
  "attention.routed": true,
  "attention.routing.failed": true,
  "attention.delivery.deferred": true,
  "attention.delivered": true,
  "attention.delivery.failed": true,
  "workflow.node.entered": true,
  "workflow.node.completed": true,
  "workflow.transition.taken": true,
  "workflow.checkpoint.saved": true,
  "task.local.created": true,
  "task.local.state.changed": true,
  "task.progress.appended": true,
  "objective.created": true,
  "objective.state.changed": true,
  "objective.focus.changed": true,
  "objective.progress.appended": true,
} as const satisfies Record<DomainEventType, true>;

/**
 * Decode the persistence envelope before it enters the typed domain.
 * Event-specific semantic invariants remain owned by the exhaustive projections,
 * which stage and validate every event before it becomes authoritative.
 */
export function parsePersistedDomainEvent(value: unknown): DomainEvent {
  const record = requireRecord(value, "domain event");
  const type = requireEventType(record.type);
  const data = requireRecord(record.data, `${type} data`);
  const parentRunId =
    record.parentRunId === undefined
      ? undefined
      : runId(requireString(record.parentRunId, "parentRunId"));

  const decoded = {
    eventId: requireNonEmptyString(record.eventId, "eventId"),
    rootRunId: runId(requireString(record.rootRunId, "rootRunId")),
    runId: runId(requireString(record.runId, "runId")),
    ...(parentRunId === undefined ? {} : { parentRunId }),
    sequence: requirePositiveInteger(record.sequence, "sequence"),
    revision: requirePositiveInteger(record.revision, "revision"),
    timestamp: requireNonEmptyString(record.timestamp, "timestamp"),
    type,
    data,
  };

  // The envelope and closed discriminator are validated here. The correlated payload
  // is validated by the type-specific projection before the event is committed to state.
  return decoded as DomainEvent;
}

export function isDomainEventType(value: unknown): value is DomainEventType {
  return typeof value === "string" && value in DOMAIN_EVENT_TYPES;
}

function requireEventType(value: unknown): DomainEventType {
  if (!isDomainEventType(value)) {
    throw new Error(`Unsupported domain event type: ${String(value)}`);
  }
  return value;
}

function requireRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, name: string): string {
  const text = requireString(value, name);
  if (text.length === 0) throw new Error(`${name} must not be empty`);
  return text;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
