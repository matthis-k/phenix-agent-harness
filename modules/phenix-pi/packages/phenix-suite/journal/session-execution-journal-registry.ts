import { createHash } from "node:crypto";
import path from "node:path";

import { findProjectRoot } from "../subagents/handle-store.ts";
import {
  SessionExecutionJournal,
  type SessionExecutionEvent,
  type SessionExecutionEventInput,
} from "./session-execution-journal.ts";

export interface SessionExecutionContext {
  readonly cwd: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly parentSessionId?: string;
  readonly childRunId?: string;
}

const journals = new Map<string, SessionExecutionJournal>();
const contextsBySession = new Map<string, SessionExecutionContext>();
const contextsByChildRun = new Map<string, SessionExecutionContext>();

function sessionDirectoryName(rootSessionId: string): string {
  const prefix = rootSessionId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "session";
  const digest = createHash("sha256").update(rootSessionId).digest("hex").slice(0, 12);
  return `${prefix}-${digest}`;
}

export function sessionExecutionJournalPath(cwd: string, rootSessionId: string): string {
  const root = findProjectRoot(cwd);
  return path.join(
    root,
    ".phenix-agent-state",
    "sessions",
    sessionDirectoryName(rootSessionId),
    "events.jsonl",
  );
}

export function sessionExecutionJournalForProject(
  cwd: string,
  rootSessionId: string,
): SessionExecutionJournal {
  const filePath = sessionExecutionJournalPath(cwd, rootSessionId);
  const existing = journals.get(filePath);
  if (existing) return existing;
  const journal = new SessionExecutionJournal({ filePath });
  journals.set(filePath, journal);
  return journal;
}

export function registerSessionExecutionContext(input: SessionExecutionContext): void {
  const context = {
    ...input,
    cwd: findProjectRoot(input.cwd),
  };
  contextsBySession.set(input.sessionId, context);
  if (input.childRunId) contextsByChildRun.set(input.childRunId, context);
}

export function unregisterSessionExecutionContext(sessionId: string): void {
  const context = contextsBySession.get(sessionId);
  contextsBySession.delete(sessionId);
  if (context?.childRunId) contextsByChildRun.delete(context.childRunId);
}

export function sessionExecutionContext(sessionId: string): SessionExecutionContext | undefined {
  return contextsBySession.get(sessionId);
}

export function sessionExecutionContextForChildRun(
  childRunId: string,
): SessionExecutionContext | undefined {
  return contextsByChildRun.get(childRunId);
}

export function recordSessionExecutionEvent(
  cwd: string,
  input: SessionExecutionEventInput,
): SessionExecutionEvent {
  return sessionExecutionJournalForProject(cwd, input.rootSessionId).append(input);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Route an existing stream/workflow trace record into the canonical root journal. */
export function recordSessionExecutionTrace(record: Readonly<Record<string, unknown>>): void {
  const sessionId = optionalString(record.sessionId);
  if (!sessionId) return;
  const context = contextsBySession.get(sessionId);
  if (!context) return;

  const boundary = optionalString(record.boundary) ?? "event";
  const actorId = optionalString(record.actorId) ?? context.actorId;
  const rootSessionId = optionalString(record.rootSessionId) ?? context.rootSessionId;
  const parentSessionId = optionalString(record.parentSessionId) ?? context.parentSessionId;
  const objectiveId = optionalString(record.objectiveId);
  const nodeId = optionalString(record.nodeId);
  const handleId = optionalString(record.handleId);
  const childRunId = optionalString(record.childRunId) ?? context.childRunId;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      [
        "rootSessionId",
        "sessionId",
        "actorId",
        "parentSessionId",
        "objectiveId",
        "nodeId",
        "handleId",
        "childRunId",
        "boundary",
      ].includes(key)
    ) {
      continue;
    }
    payload[key] = value;
  }

  recordSessionExecutionEvent(context.cwd, {
    rootSessionId,
    sessionId,
    actorId,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(objectiveId ? { objectiveId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(handleId ? { handleId } : {}),
    ...(childRunId ? { childRunId } : {}),
    type: `trace.${boundary}`,
    payload,
  });
}

export function clearSessionExecutionJournalRegistry(): void {
  journals.clear();
  contextsBySession.clear();
  contextsByChildRun.clear();
}
