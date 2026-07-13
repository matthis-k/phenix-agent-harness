import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  atomicWriteJson,
  findRepositoryRoot,
  readDirectory,
  readJsonFile,
  sanitizePathSegment,
  timestamp,
} from "../phenix-persistence/json-files.ts";
import type { HandleRecord, HandleStatus, ProducerCycleRecord } from "./handle-types.ts";
import { HANDLE_VERSION } from "./handle-types.ts";

const HANDLE_STATUSES: ReadonlySet<string> = new Set<HandleStatus>([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "orphaned",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode the stable envelope needed before a persisted handle enters runtime. */
export function decodeHandleRecord(value: unknown): HandleRecord {
  if (
    !isObject(value) ||
    value.version !== HANDLE_VERSION ||
    typeof value.id !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.modelSet !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.status !== "string" ||
    !HANDLE_STATUSES.has(value.status) ||
    !Array.isArray(value.producerCycles) ||
    !isObject(value.assignment) ||
    !isObject(value.producerSpec)
  ) {
    throw new Error("Persisted handle record is malformed or uses an unsupported version.");
  }

  return value as unknown as HandleRecord;
}

// Compatibility names retained for callers while filesystem mechanics live in
// phenix-persistence.
export const sanitize = sanitizePathSegment;
export const findProjectRoot = findRepositoryRoot;
export const now = timestamp;

export function recordsRoot(cwd: string): string {
  return path.join(findRepositoryRoot(cwd), ".phenix-agent-state", "subagents");
}

export function recordPath(cwd: string, session: string, id: string): string {
  return path.join(
    recordsRoot(cwd),
    sanitizePathSegment(session),
    `${sanitizePathSegment(id)}.json`,
  );
}

export function writeRecord(cwd: string, record: HandleRecord): void {
  record.updatedAt = timestamp();
  atomicWriteJson(recordPath(cwd, record.sessionId, record.id), record);
}

export function readRecord(cwd: string, session: string, id: string): HandleRecord | undefined {
  return readJsonFile(recordPath(cwd, session, id), decodeHandleRecord);
}

export function listRecords(cwd: string, session?: string): HandleRecord[] {
  const root = recordsRoot(cwd);
  const sessionDirectories = session ? [sanitizePathSegment(session)] : readDirectory(root);
  const records: HandleRecord[] = [];

  for (const sessionDirectory of sessionDirectories) {
    const directory = path.join(root, sessionDirectory);
    for (const file of readDirectory(directory)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = readJsonFile(path.join(directory, file), decodeHandleRecord);
        if (record) records.push(record);
      } catch {
        // Listing is diagnostic and tolerant: a damaged record does not hide
        // other valid handles. Direct reads still surface corruption.
      }
    }
  }

  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() ?? "ephemeral";
}

export function effectiveSessionId(ctx: ExtensionContext): string {
  return sessionId(ctx);
}

export type { HandleRecord, ProducerCycleRecord };
export { HANDLE_VERSION };
