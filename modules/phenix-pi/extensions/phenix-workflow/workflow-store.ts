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

// ── Atomic write helper ─────────────────────────────────────────────────────

function atomicWrite(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
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
    state: "classified",
    revision: 0,
    facts: {},
    active: [],
    completed: [],
    capabilityArtifactHash: input.capabilityArtifactHash,
    createdAt: now(),
    updatedAt: now(),
  };

  atomicWrite(recordPath(cwd, input.instanceId, input.actorId), record);
  return record;
}

// ── Write record (with atomic write) ────────────────────────────────────────

export function writeWorkflowRecord(
  cwd: string,
  record: WorkflowRuntimeRecord,
): void {
  record.updatedAt = now();
  atomicWrite(recordPath(cwd, record.instanceId, record.actorId), record);
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
  // Stale revision check
  if (input.expectedRevision !== record.revision) {
    throw new WorkflowStoreError(
      "STALE_REVISION",
      `Expected revision ${input.expectedRevision}, current is ${record.revision}`,
      { state: record.state, revision: record.revision },
    );
  }

  // Terminal state check
  if (isTerminalState(record.state)) {
    throw new WorkflowStoreError(
      "TERMINAL_STATE",
      `Cannot begin transition from terminal state: ${record.state}`,
      { state: record.state, revision: record.revision },
    );
  }

  // Check for conflict: an active transition with a different handle for the same transitionId
  // (unless it's a parallel group transition)
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
    // Already processed - idempotent
    return record;
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
    record.facts = {
      ...record.facts,
      ...input.newFacts,
    };
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
    | "TRANSITION_CONFLICT";
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
