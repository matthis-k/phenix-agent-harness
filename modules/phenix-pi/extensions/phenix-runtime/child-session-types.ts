/**
 * child-session-types — runtime-neutral child session vocabulary
 *
 * These types define the boundary between deterministic Phenix logic
 * (workflow, routing, contracts) and the Pi runtime mechanism.
 *
 * Only the runtime/composition layers may import Pi runtime types.
 * Workflow, routing, contract, and kernel definitions must not depend
 * on AgentSession, RpcClient, or other Pi implementation types.
 */

import type { AgentRole } from "../phenix-kernel/agents.ts";
import type { ThinkingLevel } from "../phenix-kernel/task.ts";
import type { AgentClientRef } from "../phenix-kernel/refs.ts";
import type { WorkflowExecutionBinding } from "../phenix-kernel/execution.ts";
import type { ModelWorkflowProjection } from "../phenix-workflow/workflow-projection.ts";

import type { ContractArtifact } from "../phenix-subagents/contract.ts";
import type { TurnBudget, ToolBudget } from "../phenix-subagents/agent-types.ts";
import type { JsonSchema } from "../phenix-subagents/contracts.ts";

// ── Branded Phenix child run identity ───────────────────────────────────────

declare const childRunIdBrand: unique symbol;

/**
 * Stable Phenix identity for a child run.
 *
 * Distinct from any Pi session ID. Never constructed by casting a Pi run ID.
 */
export type ChildRunId = string & {
  readonly [childRunIdBrand]: true;
};

export function childRunId(value: string): ChildRunId {
  return value as ChildRunId;
}

// ── Pi session reference ────────────────────────────────────────────────────

/**
 * Reference to the underlying Pi session backing a child run.
 *
 * Stored in the serializable session node and handle record. The Phenix
 * child run ID is separate from the Pi session ID.
 */
export interface PiSessionReference {
  readonly sessionId: string;
  readonly sessionFile?: string;
}

// ── Backend kind ────────────────────────────────────────────────────────────

/**
 * How a child session is backed.
 *
 * - "sdk": an independently stateful Pi AgentSession in the current process.
 * - "rpc": a Pi session controlled through the public RpcClient.
 *
 * Do not use vague values like "in-process" or "external-process".
 * An SDK child is a real independent model context even though it shares
 * the Node process.
 */
export type ChildSessionBackendKind = "sdk" | "rpc";

// ── Concrete model reference ────────────────────────────────────────────────

/**
 * A concrete provider/model pair resolved by routing before the backend starts.
 *
 * The virtual phenix/<model-set> provider must never appear here.
 */
export interface ConcreteModelRef {
  readonly provider: string;
  readonly id: string;
}

// ── Serialized error ────────────────────────────────────────────────────────

export interface SerializedError {
  readonly code: string;
  readonly message: string;
  readonly cause?: string;
}

// ── Child session status ────────────────────────────────────────────────────

export type ChildSessionStatus =
  | "starting"
  | "running"
  | "settled"
  | "completed"
  | "failed"
  | "cancelled"
  | "disposed"
  | "orphaned";

// ── Child session node (serializable projection) ────────────────────────────

/**
 * Serializable projection of a live child session.
 *
 * Contains only stable, serializable domain information.
 * Never holds a live AgentSession, RpcClient, listeners, timers,
 * AbortController, or adapter metadata.
 */
export interface ChildSessionNode {
  readonly id: ChildRunId;
  readonly parentId?: ChildRunId;
  readonly rootId: ChildRunId;

  readonly handleId: string;
  readonly role: AgentRole | null;
  readonly agentClient: AgentClientRef;

  readonly model: ConcreteModelRef;
  readonly thinkingLevel: ThinkingLevel;

  readonly contractId: string;
  readonly workflowBinding?: WorkflowExecutionBinding;

  readonly backend: ChildSessionBackendKind;
  readonly pi: PiSessionReference;

  readonly status: ChildSessionStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
}

// ── Live parent binding ─────────────────────────────────────────────────────

/**
 * Explicit parent identity and authority supplied to a child session.
 *
 * This is runtime input, not persisted adapter state. It exists so a
 * closure-bound phenix_delegate tool never has to infer its parent from
 * process globals or environment variables.
 */
export interface ChildParentExecutionContext {
  readonly kind: "child";
  readonly sessionId: string;
  readonly cwd: string;
  readonly contractId: string;
  readonly contract: ContractArtifact;
  readonly handleId: string;
  readonly childRunId: ChildRunId;
  readonly rootChildRunId: ChildRunId;
  readonly modelSet: string;
  readonly maximumDelegationDepth: number;
}

// ── Child session spec ──────────────────────────────────────────────────────

/**
 * Fully prepared specification for starting a child session.
 *
 * Built deterministically by the coordinator from the linked graph,
 * workflow context, contract, and resolved route. The backend receives
 * this and starts a live run.
 */
export interface ChildSessionSpec {
  readonly id: ChildRunId;
  readonly parentId?: ChildRunId;
  readonly rootId: ChildRunId;

  readonly handleId: string;
  readonly agentClient: AgentClientRef;
  readonly role: AgentRole | null;

  readonly cwd: string;
  readonly model: ConcreteModelRef;
  readonly thinkingLevel: ThinkingLevel;

  readonly initialPrompt: string;
  readonly contract: ContractArtifact;
  readonly workflowBinding?: WorkflowExecutionBinding;

  /**
   * Runtime-only bindings. ChildSessionNode remains the serializable
   * projection; these values are never persisted as adapter metadata.
   */
  readonly workflowProjection: ModelWorkflowProjection;
  readonly contractChannel: ContractSubmissionChannel;
  readonly parentContext: ChildParentExecutionContext;

  readonly effectiveTools: readonly string[];
  readonly skillRefs: readonly string[];
  readonly extensionRefs: readonly string[];
  readonly inheritProjectContext: boolean;

  readonly timeoutMs: number;
  readonly turnBudget: TurnBudget;
  readonly toolBudget: ToolBudget;

  readonly persistence: "memory" | "file";
}

// ── Contract submission ─────────────────────────────────────────────────────

export type ContractResultState =
  | "pending"
  | "submitted"
  | "accepted"
  | "cancelled";

export interface ExecutionIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code?: string;
}

export interface ContractSubmissionRecord {
  readonly revision: number;
  readonly submittedAt: string;
  readonly value: unknown;
  readonly disposition?:
    | "accepted"
    | "runtime-rejected"
    | "verification-rejected"
    | "critic-rejected";
  readonly issues?: readonly ExecutionIssue[];
}

export interface ContractSubmissionResult {
  readonly ok: boolean;
  readonly state: ContractResultState;
  readonly revision: number;
  readonly issues?: readonly ExecutionIssue[];
}

export interface ActiveContractAttempt {
  readonly contractId: string;
  readonly state: ContractResultState;
  readonly revision: number;
  readonly outputSchema: JsonSchema;
}

export interface ContractSubmissionChannel {
  current(): ActiveContractAttempt;
  submit(value: unknown): Promise<ContractSubmissionResult>;
  reopen(input: {
    readonly reason: "runtime-validation" | "verification" | "critic";
    readonly issues: readonly ExecutionIssue[];
  }): Promise<void>;
  accept(value: unknown): Promise<void>;
  cancel(reason: string): Promise<void>;
  readSubmitted(): Promise<{ readonly value: unknown; readonly revision: number } | undefined>;
}

// ── Normalized child session events ─────────────────────────────────────────

export type ChildSessionEvent =
  | {
      readonly type: "session.started";
      readonly runId: ChildRunId;
      readonly pi: PiSessionReference;
    }
  | {
      readonly type: "agent.event";
      readonly runId: ChildRunId;
      readonly event: unknown;
    }
  | {
      readonly type: "tool.started";
      readonly runId: ChildRunId;
      readonly toolName: string;
    }
  | {
      readonly type: "tool.completed";
      readonly runId: ChildRunId;
      readonly toolName: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "cycle.settled";
      readonly runId: ChildRunId;
      readonly cycle: number;
    }
  | {
      readonly type: "session.failed";
      readonly runId: ChildRunId;
      readonly error: SerializedError;
    }
  | {
      readonly type: "session.cancelled";
      readonly runId: ChildRunId;
      readonly reason: string;
    }
  | {
      readonly type: "session.disposed";
      readonly runId: ChildRunId;
    };

// ── Cycle outcome ───────────────────────────────────────────────────────────

export interface ChildCycleOutcome {
  readonly cycle: number;
  readonly status: "settled" | "failed" | "cancelled";
  readonly lastAssistantText?: string;
  readonly error?: SerializedError;
}

// ── Live child run interface ────────────────────────────────────────────────

/**
 * A live child run backed by a real Pi session.
 *
 * The parent interacts with the same live run through events, continue,
 * waitForCurrentCycle, abort, and dispose. The backend returns this object
 * rather than a serialized result payload.
 */
export interface ChildRun {
  readonly id: ChildRunId;
  readonly backend: ChildSessionBackendKind;
  readonly pi: PiSessionReference;

  snapshot(): ChildSessionNode;

  subscribe(
    listener: (event: ChildSessionEvent) => void,
  ): () => void;

  /**
   * Continue the same Pi session.
   *
   * If the underlying session is idle, send a normal prompt.
   * If it is streaming, queue an appropriate Pi follow-up.
   */
  continue(
    message: string,
    signal?: AbortSignal,
  ): Promise<ChildCycleOutcome>;

  waitForCurrentCycle(
    signal?: AbortSignal,
  ): Promise<ChildCycleOutcome>;

  abort(reason: string): Promise<void>;
  dispose(): Promise<void>;
}

// ── Child session backend interface ─────────────────────────────────────────

/**
 * Runtime-neutral backend that starts a live child run.
 *
 * The backend must return a live run, not a serialized result payload.
 * Both SDK and RPC backends implement this interface.
 */
export interface ChildSessionBackend {
  readonly kind: ChildSessionBackendKind;

  start(
    spec: ChildSessionSpec,
    signal: AbortSignal,
  ): Promise<ChildRun>;
}

// ── Pi runtime services ─────────────────────────────────────────────────────

/**
 * Runtime services captured or injected from the active Pi environment.
 *
 * The root extension receives Pi's ctx.modelRegistry. Children reuse the
 * same model registry — do not create a separate one with separate credentials.
 */
export interface PiRuntimeServices {
  readonly modelRegistry: unknown; // ModelRegistry — typed loosely to avoid Pi import in domain types
  readonly agentDir: string;
}

// ── Runtime error codes ─────────────────────────────────────────────────────

export type ChildRuntimeErrorCode =
  | "MODEL_NOT_FOUND"
  | "MODEL_AUTH_UNAVAILABLE"
  | "SESSION_START_FAILED"
  | "PROMPT_REJECTED"
  | "PROVIDER_FAILED"
  | "CONTRACT_NOT_SUBMITTED"
  | "CONTRACT_INVALID"
  | "TURN_BUDGET_EXCEEDED"
  | "TOOL_BUDGET_EXCEEDED"
  | "TIMEOUT"
  | "ABORTED"
  | "VERIFICATION_FAILED"
  | "CRITIC_REJECTED"
  | "REPAIR_LIMIT_EXCEEDED"
  | "RPC_PROCESS_EXITED"
  | "RPC_NESTED_DELEGATION_UNSUPPORTED"
  | "RPC_CONTRACT_RUNTIME_UNAVAILABLE"
  | "ORPHANED_SESSION";

export class ChildRuntimeError extends Error {
  readonly code: ChildRuntimeErrorCode;

  constructor(
    code: ChildRuntimeErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "ChildRuntimeError";
    this.code = code;
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof ChildRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.cause instanceof Error
        ? { cause: error.cause.message }
        : error.cause != null
          ? { cause: String(error.cause) }
          : {}),
    };
  }
  if (error instanceof Error) {
    return {
      code: "PROVIDER_FAILED",
      message: error.message,
    };
  }
  return {
    code: "PROVIDER_FAILED",
    message: String(error),
  };
}
