import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ActiveWorkflowTransition,
  CompletedWorkflowTransition,
  WorkflowDefinitionId,
  WorkflowRuntimeRecord,
  WorkflowStateId,
  WorkflowTransitionId,
} from "./workflow-types.ts";
import type { AgentKind } from "../phenix-kernel/agents.ts";
import type { Difficulty, TaskProfile } from "../phenix-kernel/task.ts";
import { isTerminalState } from "./workflow-reducer.ts";

function stateRoot(cwd: string): string {
  return path.join(cwd, ".phenix-agent-state", "workflows");
}

function sanitize(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function recordPath(
  cwd: string,
  instanceId: string,
  actorId: string,
): string {
  return path.join(
    stateRoot(cwd),
    sanitize(instanceId),
    `${sanitize(actorId)}.json`,
  );
}

function lockPath(
  cwd: string,
  instanceId: string,
  actorId: string,
): string {
  return `${recordPath(cwd, instanceId, actorId)}.lock`;
}

export function now(): string {
  return new Date().toISOString();
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

interface LockEntry {
  readonly pid: number;
  readonly timestamp: string;
  readonly instanceId: string;
  readonly actorId: string;
}

export interface LockHandle {
  readonly lockPath: string;
}

function isStaleLock(target: string): boolean {
  try {
    const entry = JSON.parse(fs.readFileSync(target, "utf-8")) as LockEntry;
    try {
      process.kill(entry.pid, 0);
    } catch {
      return true;
    }
    return Date.now() - Date.parse(entry.timestamp) > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

export function acquireWorkflowLock(
  cwd: string,
  instanceId: string,
  actorId: string,
  timeoutMs = 5_000,
): LockHandle {
  const target = lockPath(cwd, instanceId, actorId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const entry: LockEntry = {
        pid: process.pid,
        timestamp: now(),
        instanceId,
        actorId,
      };
      const fd = fs.openSync(target, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(entry), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath: target };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (isStaleLock(target)) {
        try {
          fs.unlinkSync(target);
        } catch {
          // Another process already removed it.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new WorkflowStoreError(
          "LOCK_CONTENTION",
          `Could not acquire lock for ${instanceId}/${actorId} within ${timeoutMs}ms`,
          { instanceId, actorId },
        );
      }
      Atomics.wait(LOCK_SLEEP, 0, 0, LOCK_RETRY_MS);
    }
  }
}

export function releaseWorkflowLock(handle: LockHandle): void {
  try {
    fs.unlinkSync(handle.lockPath);
  } catch {
    // Already released.
  }
}

function atomicWrite(target: string, data: unknown): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Renamed or already cleaned up.
    }
  }
}

export function readWorkflowRecord(
  cwd: string,
  instanceId: string,
  actorId: string,
): WorkflowRuntimeRecord | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(recordPath(cwd, instanceId, actorId), "utf-8"),
    ) as WorkflowRuntimeRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

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

  const lock = acquireWorkflowLock(cwd, input.instanceId, input.actorId);
  try {
    const target = recordPath(cwd, input.instanceId, input.actorId);
    if (fs.existsSync(target)) {
      throw new WorkflowStoreError(
        "WORKFLOW_EXISTS",
        `Workflow record already exists for ${input.instanceId}/${input.actorId}`,
        { instanceId: input.instanceId, actorId: input.actorId },
      );
    }
    atomicWrite(target, record);
  } finally {
    releaseWorkflowLock(lock);
  }
  return record;
}

export function writeWorkflowRecord(
  cwd: string,
  record: WorkflowRuntimeRecord,
): void {
  const lock = acquireWorkflowLock(cwd, record.instanceId, record.actorId);
  try {
    record.updatedAt = now();
    atomicWrite(recordPath(cwd, record.instanceId, record.actorId), record);
  } finally {
    releaseWorkflowLock(lock);
  }
}

export function mutateWorkflowRecord(
  cwd: string,
  instanceId: string,
  actorId: string,
  expectedRevision: number,
  mutate: (record: WorkflowRuntimeRecord) => WorkflowRuntimeRecord,
): WorkflowRuntimeRecord {
  const lock = acquireWorkflowLock(cwd, instanceId, actorId);
  try {
    const current = readWorkflowRecord(cwd, instanceId, actorId);
    if (!current) {
      throw new WorkflowStoreError(
        "WORKFLOW_NOT_FOUND",
        `Workflow record not found for ${instanceId}/${actorId}`,
        { instanceId, actorId },
      );
    }
    if (current.revision !== expectedRevision) {
      throw new WorkflowStoreError(
        "STALE_REVISION",
        `Expected revision ${expectedRevision}, current is ${current.revision}`,
        { state: current.state, revision: current.revision },
      );
    }
    const next = mutate(structuredClone(current));
    next.updatedAt = now();
    atomicWrite(recordPath(cwd, instanceId, actorId), next);
    return next;
  } finally {
    releaseWorkflowLock(lock);
  }
}

function mutateLatestWorkflowRecord(
  cwd: string,
  instanceId: string,
  actorId: string,
  mutate: (record: WorkflowRuntimeRecord) => WorkflowRuntimeRecord,
): WorkflowRuntimeRecord {
  const lock = acquireWorkflowLock(cwd, instanceId, actorId);
  try {
    const current = readWorkflowRecord(cwd, instanceId, actorId);
    if (!current) {
      throw new WorkflowStoreError(
        "WORKFLOW_NOT_FOUND",
        `Workflow record not found for ${instanceId}/${actorId}`,
        { instanceId, actorId },
      );
    }
    const next = mutate(structuredClone(current));
    if (next === current) return current;
    next.updatedAt = now();
    atomicWrite(recordPath(cwd, instanceId, actorId), next);
    return next;
  } finally {
    releaseWorkflowLock(lock);
  }
}

export function verifyWorkflowActorExists(
  cwd: string,
  instanceId: string,
  actorId: string,
): void {
  if (!readWorkflowRecord(cwd, instanceId, actorId)) {
    throw new WorkflowStoreError(
      "CHILD_ACTOR_MISSING",
      `Workflow record for child actor ${actorId} in instance ${instanceId} was not found.`,
      { instanceId, actorId },
    );
  }
}

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
  const executionId = `wfexec_${randomUUID()}`;
  const updated = mutateWorkflowRecord(
    cwd,
    record.instanceId,
    record.actorId,
    input.expectedRevision,
    (current) => {
      if (isTerminalState(current.state)) {
        throw new WorkflowStoreError(
          "TERMINAL_STATE",
          `Cannot begin transition from terminal state: ${current.state}`,
          { state: current.state, revision: current.revision },
        );
      }
      const existing = current.active.find(
        (active) => active.transitionId === input.transitionId,
      );
      if (existing) {
        throw new WorkflowStoreError(
          "TRANSITION_CONFLICT",
          `Transition ${input.transitionId} is already active`,
          { executionId: existing.executionId, revision: current.revision },
        );
      }
      const active: ActiveWorkflowTransition = {
        executionId,
        transitionId: input.transitionId,
        handleId: input.handleId,
        startedAt: now(),
      };
      current.active = [...current.active, active];
      current.revision += 1;
      return current;
    },
  );
  return { record: updated, executionId };
}

function completedOrThrow(
  record: WorkflowRuntimeRecord,
  executionId: string,
): "completed" | "active" | "unknown" {
  if (record.completed.some((item) => item.executionId === executionId)) {
    return "completed";
  }
  if (record.active.some((item) => item.executionId === executionId)) {
    return "active";
  }
  return "unknown";
}

export function acceptTransition(
  cwd: string,
  record: WorkflowRuntimeRecord,
  input: {
    readonly executionId: string;
    readonly nextState: WorkflowStateId;
    readonly newFacts?: Readonly<Record<string, unknown>>;
  },
): WorkflowRuntimeRecord {
  return mutateLatestWorkflowRecord(
    cwd,
    record.instanceId,
    record.actorId,
    (current) => {
      const status = completedOrThrow(current, input.executionId);
      if (status !== "active") {
        return current;
      }
      const activeIndex = current.active.findIndex(
        (item) => item.executionId === input.executionId,
      );
      const [active] = current.active.splice(activeIndex, 1);
      const completed: CompletedWorkflowTransition = {
        executionId: active.executionId,
        transitionId: active.transitionId,
        handleId: active.handleId,
        completedAt: now(),
        accepted: true,
      };
      current.completed = [...current.completed, completed];
      current.state = input.nextState;
      current.revision += 1;
      if (input.newFacts) {
        current.facts = { ...current.facts, ...input.newFacts };
      }
      return current;
    },
  );
}

export function rejectTransition(
  cwd: string,
  record: WorkflowRuntimeRecord,
  input: {
    readonly executionId: string;
    readonly nextState: WorkflowStateId;
  },
): WorkflowRuntimeRecord {
  return mutateLatestWorkflowRecord(
    cwd,
    record.instanceId,
    record.actorId,
    (current) => {
      const status = completedOrThrow(current, input.executionId);
      if (status !== "active") {
        return current;
      }
      const activeIndex = current.active.findIndex(
        (item) => item.executionId === input.executionId,
      );
      const [active] = current.active.splice(activeIndex, 1);
      const completed: CompletedWorkflowTransition = {
        executionId: active.executionId,
        transitionId: active.transitionId,
        handleId: active.handleId,
        completedAt: now(),
        accepted: false,
      };
      current.completed = [...current.completed, completed];
      current.state = input.nextState;
      current.revision += 1;
      return current;
    },
  );
}

export function hashCapabilityContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class WorkflowStoreError extends Error {
  readonly code:
    | "STALE_REVISION"
    | "TERMINAL_STATE"
    | "TRANSITION_CONFLICT"
    | "LOCK_CONTENTION"
    | "CHILD_ACTOR_MISSING"
    | "WORKFLOW_NOT_FOUND"
    | "WORKFLOW_EXISTS"
    | "UNKNOWN_EXECUTION";
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
