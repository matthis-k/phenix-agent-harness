import { isDomainEventType, type DomainEvent } from "./events.ts";
import { runId } from "../shared.ts";

/**
 * Decode the persisted event envelope before it enters the typed domain.
 * The closed discriminator is checked here; type-specific semantic payload invariants
 * are then staged through the exhaustive projections before becoming authoritative.
 */
export function parsePersistedDomainEvent(value: unknown): DomainEvent {
  const record = requireRecord(value, "domain event");
  const rawType = requireString(record.type, "type");
  if (!isDomainEventType(rawType)) {
    throw new Error(`Unsupported domain event type: ${rawType}`);
  }
  const data = requireRecord(record.data, `${rawType} data`);
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
    type: rawType,
    data,
  };

  // One audited assertion is retained at the persistence boundary. Internal event
  // construction remains fully discriminator/payload correlated and cast-free.
  return decoded as DomainEvent;
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
