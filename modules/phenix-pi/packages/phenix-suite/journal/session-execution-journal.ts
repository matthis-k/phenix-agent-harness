import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const JOURNAL_SCHEMA_VERSION = 1;
const MAX_STRING_LENGTH = 8_192;
const MAX_PREVIEW_LENGTH = 512;
const MAX_COLLECTION_ITEMS = 128;
const MAX_DEPTH = 8;
const SENSITIVE_KEY =
  /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie)/i;
const REASONING_KEY = /(?:thinking|reasoning|chain[-_]?of[-_]?thought)/i;

export interface SessionExecutionEventInput {
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly parentSessionId?: string;
  readonly objectiveId?: string;
  readonly nodeId?: string;
  readonly handleId?: string;
  readonly childRunId?: string;
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface SessionExecutionEvent extends SessionExecutionEventInput {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly sequence: number;
  readonly eventId: string;
  readonly timestamp: string;
  readonly pid: number;
}

export interface SessionExecutionJournalOptions {
  readonly filePath: string;
  readonly now?: () => string;
  readonly createEventId?: () => string;
}

export type SessionExecutionJournalListener = (event: SessionExecutionEvent) => void;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedString(value: string, key: string | undefined): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
  if (key && REASONING_KEY.test(key)) {
    return { redacted: true, length: value.length, sha256: sha256(value) };
  }
  if (value.length <= MAX_STRING_LENGTH) return value;
  return {
    truncated: true,
    length: value.length,
    sha256: sha256(value),
    preview: value.slice(0, MAX_PREVIEW_LENGTH),
  };
}

function sanitizeValue(value: unknown, key?: string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[maximum-depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundedString(value, key);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value === "function" || typeof value === "symbol") return String(value);

  if (Array.isArray(value)) {
    const values: unknown[] = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => sanitizeValue(item, undefined, depth + 1));
    if (value.length > MAX_COLLECTION_ITEMS) {
      values.push({ truncatedItems: value.length - MAX_COLLECTION_ITEMS });
    }
    return values;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: boundedString(value.message, "message"),
      ...(value.cause === undefined
        ? {}
        : { cause: sanitizeValue(value.cause, "cause", depth + 1) }),
    };
  }

  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.entries(record).slice(0, MAX_COLLECTION_ITEMS);
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of entries) {
      const next = sanitizeValue(entryValue, entryKey, depth + 1);
      if (next !== undefined) sanitized[entryKey] = next;
    }
    const count = Object.keys(record).length;
    if (count > MAX_COLLECTION_ITEMS) sanitized.truncatedKeys = count - MAX_COLLECTION_ITEMS;
    return sanitized;
  }

  return String(value);
}

export function sanitizeSessionExecutionPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!payload) return undefined;
  return sanitizeValue(payload) as Readonly<Record<string, unknown>>;
}

function readEvents(filePath: string): readonly SessionExecutionEvent[] {
  if (!existsSync(filePath)) return [];
  const events: SessionExecutionEvent[] = [];
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as SessionExecutionEvent;
      if (
        event.schemaVersion === JOURNAL_SCHEMA_VERSION &&
        Number.isSafeInteger(event.sequence) &&
        event.sequence > 0
      ) {
        events.push(event);
      }
    } catch {
      // A torn trailing record is ignored. New events continue from the last
      // valid durable sequence rather than making the entire journal unreadable.
    }
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}

function requireIdentifier(name: string, value: string): void {
  if (!value.trim()) throw new TypeError(`${name} must be non-empty.`);
}

/**
 * Single synchronous writer for one root-session tree.
 *
 * Child processes and SDK children report observations to the root runtime; only
 * this object assigns the global sequence and appends canonical records.
 */
export class SessionExecutionJournal {
  readonly filePath: string;

  private readonly now: () => string;
  private readonly createEventId: () => string;
  private readonly listeners = new Set<SessionExecutionJournalListener>();
  private sequenceValue: number;

  constructor(options: SessionExecutionJournalOptions) {
    this.filePath = path.resolve(options.filePath);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createEventId = options.createEventId ?? (() => `journal_event_${randomUUID()}`);
    this.sequenceValue = readEvents(this.filePath).at(-1)?.sequence ?? 0;
  }

  get sequence(): number {
    return this.sequenceValue;
  }

  append(input: SessionExecutionEventInput): SessionExecutionEvent {
    requireIdentifier("rootSessionId", input.rootSessionId);
    requireIdentifier("sessionId", input.sessionId);
    requireIdentifier("actorId", input.actorId);
    requireIdentifier("type", input.type);

    const event: SessionExecutionEvent = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      sequence: this.sequenceValue + 1,
      eventId: this.createEventId(),
      timestamp: this.now(),
      pid: process.pid,
      rootSessionId: input.rootSessionId,
      sessionId: input.sessionId,
      actorId: input.actorId,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.handleId ? { handleId: input.handleId } : {}),
      ...(input.childRunId ? { childRunId: input.childRunId } : {}),
      type: input.type,
      ...(input.payload ? { payload: sanitizeSessionExecutionPayload(input.payload) } : {}),
    };

    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.sequenceValue = event.sequence;

    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Observers are projections and must not affect durable journal writes.
      }
    }
    return event;
  }

  readAll(): readonly SessionExecutionEvent[] {
    return readEvents(this.filePath);
  }

  subscribe(listener: SessionExecutionJournalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
