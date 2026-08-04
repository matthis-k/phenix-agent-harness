import {
  type EvidenceRecord,
  type EvidenceSource,
  evidenceId,
  MEMORY_KINDS,
  type MemoryNote,
  memoryNoteId,
} from "./model.ts";
import { objectiveId, runId } from "../shared.ts";

export type MemoryLedgerEntry =
  | { readonly type: "evidence.recorded"; readonly value: EvidenceRecord }
  | { readonly type: "notes.recorded"; readonly value: readonly MemoryNote[] };

const MEMORY_STATUSES = ["active", "superseded", "invalidated", "uncertain"] as const;
const MEMORY_RELIABILITIES = ["observed", "derived", "reported"] as const;
const MEMORY_RETENTIONS = [
  "must-retain",
  "structured-lossless",
  "summary-sufficient",
  "ephemeral",
] as const;
const MEDIA_TYPES = ["application/json", "text/plain", "text/markdown"] as const;

export function parseMemoryLedgerEntry(value: unknown): MemoryLedgerEntry {
  const record = requireRecord(value, "memory ledger entry");
  assertKnownKeys(record, ["type", "value"], "memory ledger entry");
  const type = requireString(record.type, "memory ledger entry type");
  switch (type) {
    case "evidence.recorded":
      return { type, value: parseEvidenceRecord(record.value) };
    case "notes.recorded":
      return { type, value: parseMemoryNoteBatch(record.value) };
    default:
      throw new Error(`Unsupported memory ledger entry type: ${type}`);
  }
}

export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  const record = requireRecord(value, "evidence record");
  assertKnownKeys(
    record,
    [
      "id",
      "rootRunId",
      "runId",
      "objectiveIds",
      "source",
      "contentHash",
      "mediaType",
      "sizeBytes",
      "preview",
      "createdAt",
    ],
    "evidence record",
  );
  const contentHash = requireString(record.contentHash, "evidence contentHash");
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error("evidence contentHash must be a lowercase SHA-256 digest");
  }
  return {
    id: evidenceId(requireString(record.id, "evidence id")),
    rootRunId: runId(requireString(record.rootRunId, "evidence rootRunId")),
    runId: runId(requireString(record.runId, "evidence runId")),
    objectiveIds: parseStringArray(record.objectiveIds, "evidence objectiveIds").map((id) =>
      objectiveId(id),
    ),
    source: parseEvidenceSource(record.source),
    contentHash,
    mediaType: parseEnum(record.mediaType, MEDIA_TYPES, "evidence mediaType"),
    sizeBytes: requireNonNegativeInteger(record.sizeBytes, "evidence sizeBytes"),
    preview: requireBoundedString(record.preview, "evidence preview", 320),
    createdAt: requireTimestamp(record.createdAt, "evidence createdAt"),
  };
}

export function parseMemoryNote(value: unknown): MemoryNote {
  const record = requireRecord(value, "memory note");
  assertKnownKeys(
    record,
    [
      "id",
      "rootRunId",
      "runId",
      "objectiveIds",
      "kind",
      "status",
      "retention",
      "reliability",
      "summary",
      "subject",
      "evidenceIds",
      "supersedes",
      "invalidatedBy",
      "createdAt",
      "updatedAt",
    ],
    "memory note",
  );
  const subject = optionalString(record.subject, "memory note subject", 500);
  const supersedes = optionalStringArray(record.supersedes, "memory note supersedes")?.map((id) =>
    memoryNoteId(id),
  );
  const status = parseEnum(record.status, MEMORY_STATUSES, "memory note status");
  const invalidatedBy =
    record.invalidatedBy === undefined
      ? undefined
      : memoryNoteId(requireString(record.invalidatedBy, "memory note invalidatedBy"));
  if (status !== "invalidated" && invalidatedBy !== undefined) {
    throw new Error("memory note invalidatedBy is only valid for invalidated notes");
  }

  const base = {
    id: memoryNoteId(requireString(record.id, "memory note id")),
    rootRunId: runId(requireString(record.rootRunId, "memory note rootRunId")),
    runId: runId(requireString(record.runId, "memory note runId")),
    objectiveIds: parseStringArray(record.objectiveIds, "memory note objectiveIds").map((id) =>
      objectiveId(id),
    ),
    kind: parseEnum(record.kind, MEMORY_KINDS, "memory note kind"),
    retention: parseEnum(record.retention, MEMORY_RETENTIONS, "memory note retention"),
    reliability: parseEnum(record.reliability, MEMORY_RELIABILITIES, "memory note reliability"),
    summary: requireBoundedString(record.summary, "memory note summary", 2_000),
    ...(subject === undefined ? {} : { subject }),
    evidenceIds: parseStringArray(record.evidenceIds, "memory note evidenceIds").map((id) =>
      evidenceId(id),
    ),
    ...(supersedes === undefined ? {} : { supersedes }),
    createdAt: requireTimestamp(record.createdAt, "memory note createdAt"),
    updatedAt: requireTimestamp(record.updatedAt, "memory note updatedAt"),
  };

  if (status === "invalidated") {
    return {
      ...base,
      status,
      ...(invalidatedBy === undefined ? {} : { invalidatedBy }),
    };
  }
  return { ...base, status };
}

export function assertValidMemoryNoteTransition(
  previous: MemoryNote,
  next: MemoryNote,
): void {
  const immutableFields = [
    "rootRunId",
    "runId",
    "kind",
    "retention",
    "reliability",
    "summary",
    "subject",
    "createdAt",
  ] as const;
  for (const field of immutableFields) {
    if (previous[field] !== next[field]) {
      throw new Error(`Memory note ${next.id} changed immutable field ${field}`);
    }
  }
  if (!sameArray(previous.objectiveIds, next.objectiveIds)) {
    throw new Error(`Memory note ${next.id} changed immutable objective scope`);
  }
  if (!sameArray(previous.evidenceIds, next.evidenceIds)) {
    throw new Error(`Memory note ${next.id} changed immutable evidence references`);
  }
  if (!sameArray(previous.supersedes ?? [], next.supersedes ?? [])) {
    throw new Error(`Memory note ${next.id} changed immutable supersedes references`);
  }
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new Error(`Memory note ${next.id} moved updatedAt backwards`);
  }
}

function parseMemoryNoteBatch(value: unknown): readonly MemoryNote[] {
  if (!Array.isArray(value)) throw new Error("memory note batch must be an array");
  if (value.length === 0) throw new Error("memory note batch must not be empty");
  if (value.length > 128) throw new Error("memory note batch must not exceed 128 entries");
  const notes = value.map((item) => parseMemoryNote(item));
  const ids = new Set<string>();
  for (const note of notes) {
    if (ids.has(note.id)) throw new Error(`Duplicate memory note in batch: ${note.id}`);
    ids.add(note.id);
  }
  return notes;
}

function parseEvidenceSource(value: unknown): EvidenceSource {
  const record = requireRecord(value, "evidence source");
  const kind = requireString(record.kind, "evidence source kind");
  switch (kind) {
    case "tool-result":
      assertKnownKeys(record, ["kind", "toolName", "toolCallId"], "tool-result source");
      return {
        kind,
        toolName: requireBoundedString(record.toolName, "tool-result toolName", 160),
        toolCallId: requireBoundedString(record.toolCallId, "tool-result toolCallId", 320),
      };
    case "run-outcome":
      assertKnownKeys(record, ["kind", "childRunId"], "run-outcome source");
      return { kind, childRunId: runId(requireString(record.childRunId, "childRunId")) };
    case "domain-event":
      assertKnownKeys(record, ["kind", "eventId"], "domain-event source");
      return { kind, eventId: requireBoundedString(record.eventId, "eventId", 320) };
    case "manual":
      assertKnownKeys(record, ["kind", "actorRunId"], "manual source");
      return { kind, actorRunId: runId(requireString(record.actorRunId, "actorRunId")) };
    default:
      throw new Error(`Unsupported evidence source kind: ${kind}`);
  }
}

function requireRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertKnownKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  name: string,
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${name} contains unknown fields: ${unknown.join(", ")}`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireBoundedString(value: unknown, name: string, maximum: number): string {
  const text = requireString(value, name);
  if (text.length === 0) throw new Error(`${name} must not be empty`);
  if (text.length > maximum) throw new Error(`${name} must not exceed ${maximum} characters`);
  return text;
}

function optionalString(value: unknown, name: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requireBoundedString(value, name, maximum);
}

function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireBoundedString(value, name, 64);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${name} must be an ISO timestamp`);
  return timestamp;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function parseStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > 1_024) throw new Error(`${name} must not exceed 1024 entries`);
  return value.map((item, index) => requireString(item, `${name}[${index}]`));
}

function optionalStringArray(value: unknown, name: string): readonly string[] | undefined {
  return value === undefined ? undefined : parseStringArray(value, name);
}

function parseEnum<const TValue extends string>(
  value: unknown,
  values: readonly TValue[],
  name: string,
): TValue {
  const text = requireString(value, name);
  if (!values.includes(text as TValue)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return text as TValue;
}

function sameArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
