import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { HandleRecord, ProducerCycleRecord } from "./handle-types.ts";
import { HANDLE_VERSION } from "./handle-types.ts";

// ── Path helpers ────────────────────────────────────────────────────────────

export function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function findProjectRoot(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export function now(): string {
  return new Date().toISOString();
}

// ── Record persistence ──────────────────────────────────────────────────────

export function recordsRoot(cwd: string): string {
  return path.join(findProjectRoot(cwd), ".phenix-agent-state", "subagents");
}

export function recordPath(cwd: string, session: string, id: string): string {
  return path.join(recordsRoot(cwd), sanitize(session), `${sanitize(id)}.json`);
}

export function writeRecord(cwd: string, record: HandleRecord): void {
  record.updatedAt = now();
  const target = recordPath(cwd, record.sessionId, record.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function readRecord(cwd: string, session: string, id: string): HandleRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordPath(cwd, session, id), "utf-8")) as HandleRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function listRecords(cwd: string, session?: string): HandleRecord[] {
  const root = recordsRoot(cwd);
  const sessionDirs = session ? [sanitize(session)] : safeReadDir(root);
  const records: HandleRecord[] = [];
  for (const sessionDir of sessionDirs) {
    const dir = path.join(root, sessionDir);
    for (const file of safeReadDir(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as HandleRecord;
        if (record.version === HANDLE_VERSION) records.push(record);
      } catch {
        // A partially written or manually damaged record is ignored; atomic writes prevent normal partial files.
      }
    }
  }
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function findByRunId(_cwd: string, _runId: string | undefined): HandleRecord | undefined {
  // In the Pi-native architecture, run IDs are not stored on producer cycles.
  // Use findByChildRunId or findById instead.
  return undefined;
}

// ── Producer cycle helpers ───────────────────────────────────────────────────

export function latestProducerCycle(record: HandleRecord): ProducerCycleRecord {
  const cycle = record.producerCycles.at(-1);
  if (!cycle) throw new Error(`handle ${record.id} has no producer cycles`);
  return cycle;
}

export function recordChildSessions(
  record: HandleRecord,
  children: readonly {
    readonly agent?: string;
    readonly success?: boolean;
    readonly exitCode?: number | null;
    readonly sessionFile?: string;
    readonly transcriptPath?: string;
  }[],
): void {
  latestProducerCycle(record).childSessions = children.map((child, index) => ({
    role: child.agent ?? (index === 0 ? record.producerSpec.agent : record.criticSpec?.agent ?? `child-${index}`),
    status: child.success === false || (child.exitCode !== undefined && child.exitCode !== null && child.exitCode !== 0)
      ? "failed"
      : "completed",
    ...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
    ...(child.transcriptPath ? { transcriptPath: child.transcriptPath } : {}),
  }));
}

// ── Session helpers ──────────────────────────────────────────────────────────

export function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() ?? "ephemeral";
}

export function currentParentRecord(_cwd: string): HandleRecord | undefined {
  // In the Pi-native child-session architecture, parent run IDs are not
  // propagated through environment variables. The coordinator manages
  // child sessions directly and records their handles.
  return undefined;
}

export function effectiveSessionId(ctx: ExtensionContext): string {
  return currentParentRecord(ctx.cwd)?.sessionId ?? sessionId(ctx);
}

// Re-export for convenience
export type { HandleRecord, ProducerCycleRecord };
export { HANDLE_VERSION };
