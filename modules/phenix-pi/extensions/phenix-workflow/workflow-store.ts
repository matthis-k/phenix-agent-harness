import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type {
  WorkflowRuntimeRecord,
  ActiveWorkflowTransition,
  CompletedWorkflowTransition,
  WorkflowStateId,
  WorkflowTransitionId,
  WorkflowDefinitionId,
} from "./workflow-types.ts";
import type { Difficulty, TaskProfile } from "../phenix-routing/types.ts";
import type { AgentRole, AgentKind } from "../phenix-subagents/agent-types.ts";
import { isTerminalState } from "./workflow-reducer.ts";

// ── Path helpers ────────────────────────────────────────────────────────────

function stateRoot(cwd: string): string {
  return path.join(cwd, ".phenix-agent-state", "workflows");
}

function recordPath(
  cwd: string,
  instanceId: string,
  actorId: string,
): string {
  return path.join(stateRoot(cwd), sanitize(instanceId), `${sanitize(actorId)}.json`);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function now(): string {
  return new Date().toISOString();
}

// ── Cross-process lock ──────────────────────────────────────────────────────

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 100;

interface LockEntry {
  pid: number;
  timestamp: string;
  instanceId: string;
  actorId: string;
}

export interface LockHandle {
  readonly lockPath: string;
}

function lockPath(cwd: string, instanceId: string, actorId: string): string {
  return recordPath(cwd, instanceId, actorId) + ".lock";
}

function isStaleLock(lp: string): boolean {
  try {
    const raw = fs.readFileSync(lp, "utf-8");
    const entry = JSON.parse(raw) as LockEntry;
    try {
      process.kill(entry.pid, 0);
    } catch {
      return true; // process dead
    }
    const age = Date.now() - new Date(entry.timestamp).getTime();
    return age > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

/**
 * Acquire a cross-process lock for a workflow record.
 *
 * PID-stamped lock file. Stale locks are broken and retaken.
 * Live locks from another process cause LOCK_CONTENTION error.
 */
export function acquireWorkflowLock(
  cwd: string,
  instanceId: string,
  actorId: string,
  timeoutMs = 5_000,
): LockHandle {
  const lp = lockPath(cwd, instanceId, actorId);
  const dir = path.dirname(lp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const entry: LockEntry = {
        pid: process.pid,
        timestamp: now(),
        instanceId,
        actorId,
      };
      const fd = fs.openSync(lp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(entry), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath: lp };
    } catch {
      if (!isStaleLock(lp)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new WorkflowStoreError(
            "LOCK_CONTENTION",
            `Could not acquire lock for ${instanceId}/${actorId} within ${timeoutMs}ms`,
            { instanceId, actorId },
          );
        }
        const start = Date.now();
        while (Date.now() - start < Math.min(LOCK_RETRY_MS, remaining)) { /* spin */ }
        continue;
      }
      try { fs.unlinkSync(lp); } catch { /* gone */ }
      continue;
    }
  }

  throw new WorkflowStoreError(
    "LOCK_CONTENTION",
    `Timed out acquiring lock for ${instanceId}/${actorId}`,
    { instanceId, actorId },
  );
}

export function releaseWorkflowLock(handle: LockHandle): void {
  try { fs.unlinkSync(handle.lockPath); } catch { /* already released */ }
}

// ── Atomic write with fsync ─────────────────────────────────────────────────

function atomicWrite(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* cleanup */ }
  }
}

function atomicWriteLocked(
  cwd: string,
  instanceId: string,
  actorId: string,
  data: unknown,
): void {
  const lock = acquireWorkflowLock(cwd, instanceId, actorId);
  try {
    atomicWrite(recordPath(cwd, instanceId, actorId), data);
  } finally {
    releaseWorkflowLock(lock);
  }
}

// ── Read record ─────────────────────────────────────────────────────────────

export function readWorkflowRecord(
  cwd: string,
  instanceId: string,
  actorId: string,
): WorkflowRuntimeRecord | undefined {
  const filePath = recordPath(cwd, instanceId, actorId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as WorkflowRuntimeRecord;
  } catch {
    return undefined;
  }
}

// ── Create record ───────────────────────────────────────────────────────────

export function createWorkflowRecord(
  cwd: string,
  input: {
    readonly instanceId: string;
    readonly actorId: string;
    readonly parentActorId?: string;
    readonly sessionId: string;
    readonly definitionId: WorkflowDefinitionId;
    readonly difficulty: Difficulty;
    readonly taskProfile: TaskProfile;
    readonly actorRole: "coordinator" | AgentKind | "base";
    readonly capabilityArtifactHash: string;
    readonly initialState?: WorkflowStateId;
  },
): WorkflowRuntimeRecord {
  const record: WorkflowRuntimeRecord = {
    version: 1,
    instanceId: input.instanceId,
    actorId: input.actorId,
    ...(input.parentActorId ? { parentActorId: input.parentActorId } : {}),
    sessionId: input.sessionId,
    definitionId: input.definitionId,
    definitionVersion: 1,
    difficulty: input.difficulty,
    taskProfile: input.taskProfile,
    actorRole: input.actorRole,
    state: input.initialState ?? "classified",
    revision: 0,
    facts: {},
    active: [],
    completed: [],
    capabilityArtifactHash: input.capabilityArtifactHash,
    createdAt: now(),
    updatedAt: now(),
  };

  atomicWriteLocked(cwd, input.instanceId, input.actorId, record);
  return record;
}

// ── Write record (cross-process locked) ─────────────────────────────────────

export function writeWorkflowRecord(
  cwd: string,
  record: WorkflowRuntimeRecord,
): void {
  record.updatedAt = now();
  atomicWriteLocked(cwd, record.instanceId, record.actorId, record);
}

// ── Mutate record (lock + read + CAS + write) ──────────────────────────────

/**
 * Acquire the cross-process lock, read the current record, validate
 * the revision, apply the mutation, and write the result atomically.
 *
 * If the record does not exist, or the revision does not match the
 * expected value, a STALE_REVISION error is thrown. If the mutate
 * callback returns null, the mutation is declined and the unchanged
 * record is returned, but the lock is still released.
 */
export function mutateWorkflowRecord(
  cwd: string,
  instanceId: string,
  actorId: string,
  expectedRevision: number,
  mutate: (record: WorkflowRuntimeRecord) => WorkflowRuntimeRecord | null,
): WorkflowRuntimeRecord {
  const lock = acquireWorkflowLock(cwd, instanceId, actorId);
  try {
    const record = readWorkflowRecord(cwd, instanceId, actorId);
    if (!record) {
      throw new WorkflowStoreError(
        "STALE_REVISION",
        `Workflow record not found for ${instanceId}/${actorId}`,
        { instanceId, actorId },
      );
    }
    if (record.revision !== expectedRevision) {
      throw new WorkflowStoreError(
        "STALE_REVISION",
        `Expected revision ${expectedRevision}, current is ${record.revision}`,
        { state: record.state, revision: record.revision },
      );
    }
    const result = mutate(record);
    if (result === null) return record; // mutation declined
    result.updatedAt = now();
    atomicWrite(recordPath(cwd, instanceId, actorId), result);
    return result;
  } finally {
    releaseWorkflowLock(lock);
  }
}

/**
 * Verify that a workflow actor record exists. Fails with CHILD_ACTOR_MISSING
 * if the record does not exist — used during child agent bootstrap to ensure
 * the workflow store is consistent before spawning.
 */
export function verifyWorkflowActorExists(
  cwd: string,
  instanceId: string,
  actorId: string,
): void {
  const record = readWorkflowRecord(cwd, instanceId, actorId);
  if (!record) {
    throw new WorkflowStoreError(
      "CHILD_ACTOR_MISSING",
      `Workflow record for child actor ${actorId} in instance ${instanceId} not found. ` +
      `The parent must create the child actor record before spawning the child agent.`,
      { instanceId, actorId },
    );
  }
}

// ── Begin transition ────────────────────────────────────────────────────────

export interface BeginTransitionResult {
  readonly record: WorkflowRuntimeRecord;
  readonly executionId: string;
}

export function beginTransition(
  cwd: string,
  record: WorkflowRuntimeRecord,
  input: {
    readonly expectedRevision: number;
    readonly transitionId: WorkflowTransitionId;
    readonly handleId: string;
  },
): BeginTransitionResult {
  if (input.expectedRevision !== record.revision) {
    throw new WorkflowStoreError(
      "STALE_REVISION",
      `Expected revision ${input.expectedRevision}, current is ${record.revision}`,
      { state: record.state, revision: record.revision },
    );
  }

  if (isTerminalState(record.state)) {
    throw new WorkflowStoreError(
      "TERMINAL_STATE",
      `Cannot begin transition from terminal state: ${record.state}`,
      { state: record.state, revision: record.revision },
    );
  }

  const existingSame = record.active.find(
    (a) => a.transitionId === input.transitionId,
  );
  if (existingSame) {
    throw new WorkflowStoreError(
      "TRANSITION_CONFLICT",
      `Transition ${input.transitionId} already active (executionId: ${existingSame.executionId})`,
      { state: record.state, revision: record.revision },
    );
  }

  const executionId = `wfexec_${randomUUID()}`;

  const active: ActiveWorkflowTransition = {
    executionId,
    transitionId: input.transitionId,
    handleId: input.handleId,
    startedAt: now(),
  };

  record.active = [...record.active, active];
  record.revision += 1;
  record.updatedAt = now();

  writeWorkflowRecord(cwd, record);

  return { record, executionId };
}

// ── Accept transition ───────────────────────────────────────────────────────

export function acceptTransition(
  cwd: string,
  record: WorkflowRuntimeRecord,
  input: {
    readonly executionId: string;
    readonly nextState: WorkflowStateId;
    readonly newFacts?: Readonly<Record<string, unknown>>;
  },
): WorkflowRuntimeRecord {
  const activeIndex = record.active.findIndex(
    (a) => a.executionId === input.executionId,
  );

  if (activeIndex === -1) {
    return record; // Idempotent
  }

  const [active] = record.active.splice(activeIndex, 1);

  const completed: CompletedWorkflowTransition = {
    executionId: active.executionId,
    transitionId: active.transitionId,
    handleId: active.handleId,
    completedAt: now(),
    accepted: true,
  };

  record.completed = [...record.completed, completed];
  record.state = input.nextState;
  record.revision += 1;

  if (input.newFacts) {
    record.facts = { ...record.facts, ...input.newFacts };
  }

  writeWorkflowRecord(cwd, record);
  return record;
}

// ── Reject transition ───────────────────────────────────────────────────────

export function rejectTransition(
  cwd: string,
  record: WorkflowRuntimeRecord,
  input: {
    readonly executionId: string;
    readonly nextState: WorkflowStateId;
  },
): WorkflowRuntimeRecord {
  const activeIndex = record.active.findIndex(
    (a) => a.executionId === input.executionId,
  );

  if (activeIndex === -1) {
    return record; // Idempotent
  }

  const [active] = record.active.splice(activeIndex, 1);

  const completed: CompletedWorkflowTransition = {
    executionId: active.executionId,
    transitionId: active.transitionId,
    handleId: active.handleId,
    completedAt: now(),
    accepted: false,
  };

  record.completed = [...record.completed, completed];
  record.state = input.nextState;
  record.revision += 1;

  writeWorkflowRecord(cwd, record);
  return record;
}

// ── Hasher ──────────────────────────────────────────────────────────────────

export function hashCapabilityContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Store error ─────────────────────────────────────────────────────────────

export class WorkflowStoreError extends Error {
  readonly code:
    | "STALE_REVISION"
    | "TERMINAL_STATE"
    | "TRANSITION_CONFLICT"
    | "LOCK_CONTENTION"
    | "CHILD_ACTOR_MISSING";
  readonly context: Record<string, unknown>;

  constructor(
    code: WorkflowStoreError["code"],
    message: string,
    context: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowStoreError";
    this.code = code;
    this.context = context;
  }
}
