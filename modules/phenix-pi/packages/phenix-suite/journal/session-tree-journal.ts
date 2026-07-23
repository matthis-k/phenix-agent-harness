import fs from "node:fs";
import path from "node:path";
import {
  sanitizeSessionExecutionValue,
  type SessionExecutionEvent,
} from "./session-execution-journal.ts";
import {
  sessionExecutionJournalForProject,
  sessionExecutionJournalPath,
} from "./session-execution-journal-registry.ts";

interface JsonlRow {
  readonly line: number;
  readonly value: unknown;
}

export interface SessionTreeJournalResult {
  readonly filePath: string;
  readonly recordCount: number;
  readonly sourceFiles: readonly string[];
}

interface SessionTreeRecord {
  readonly schemaVersion: 1;
  readonly type: "session-tree.record";
  readonly rootSessionId: string;
  readonly timestamp: string;
  readonly sessionId?: string;
  readonly source: {
    readonly kind: "execution-journal" | "pi-session";
    readonly path: string;
    readonly line: number;
  };
  readonly record: unknown;
}

function readJsonl(filePath: string): readonly JsonlRow[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: JsonlRow[] = [];
  for (const [index, line] of fs.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push({ line: index + 1, value: JSON.parse(line) });
    } catch {
      rows.push({
        line: index + 1,
        value: {
          type: "invalid-jsonl-record",
          raw: { redacted: true, length: line.length },
        },
      });
    }
  }
  return rows;
}

function recordValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function recordString(value: unknown, key: string): string | undefined {
  const candidate = recordValue(value, key);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function recordTimestamp(value: unknown, fallback: string): string {
  return (
    recordString(value, "timestamp") ??
    recordString(recordValue(value, "message"), "timestamp") ??
    fallback
  );
}

function sessionIdFromRows(rows: readonly JsonlRow[]): string | undefined {
  for (const row of rows) {
    if (recordString(row.value, "type") !== "session") continue;
    const id = recordString(row.value, "id");
    if (id) return id;
  }
  return undefined;
}

function sessionFilesFromEvents(
  events: readonly SessionExecutionEvent[],
  rootSessionFile: string | undefined,
): readonly string[] {
  const files = new Set<string>();
  if (rootSessionFile) files.add(path.resolve(rootSessionFile));
  for (const event of events) {
    const payload = event.payload;
    const direct =
      payload && typeof payload.sessionFile === "string" ? payload.sessionFile : undefined;
    const pi = payload?.pi;
    const nested =
      typeof pi === "object" &&
      pi !== null &&
      typeof (pi as Record<string, unknown>).sessionFile === "string"
        ? ((pi as Record<string, unknown>).sessionFile as string)
        : undefined;
    if (direct) files.add(path.resolve(direct));
    if (nested) files.add(path.resolve(nested));
  }
  return [...files].filter((candidate) => fs.existsSync(candidate)).sort();
}

/** Materialize one chronological, sanitized JSONL containing canonical events and known Pi sessions. */
export function generateSessionTreeJournal(input: {
  readonly cwd: string;
  readonly rootSessionId: string;
  readonly rootSessionFile?: string;
}): SessionTreeJournalResult {
  const journal = sessionExecutionJournalForProject(input.cwd, input.rootSessionId);
  const events = journal.readAll();
  const journalPath = sessionExecutionJournalPath(input.cwd, input.rootSessionId);
  const sources = sessionFilesFromEvents(events, input.rootSessionFile);
  const records: SessionTreeRecord[] = events.map((event) => ({
    schemaVersion: 1,
    type: "session-tree.record",
    rootSessionId: input.rootSessionId,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    source: { kind: "execution-journal", path: journalPath, line: event.sequence },
    record: event,
  }));

  for (const sourcePath of sources) {
    const rows = readJsonl(sourcePath);
    const sessionId = sessionIdFromRows(rows);
    for (const row of rows) {
      records.push({
        schemaVersion: 1,
        type: "session-tree.record",
        rootSessionId: input.rootSessionId,
        timestamp: recordTimestamp(row.value, "9999-12-31T23:59:59.999Z"),
        ...(sessionId ? { sessionId } : {}),
        source: { kind: "pi-session", path: sourcePath, line: row.line },
        record: sanitizeSessionExecutionValue(row.value),
      });
    }
  }

  records.sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) ||
      left.source.kind.localeCompare(right.source.kind) ||
      left.source.path.localeCompare(right.source.path) ||
      left.source.line - right.source.line,
  );

  const filePath = path.join(path.dirname(journalPath), "full.jsonl");
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
  return {
    filePath,
    recordCount: records.length,
    sourceFiles: [journalPath, ...sources],
  };
}
