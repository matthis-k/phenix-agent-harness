/** Runtime-neutral child session vocabulary. */

import type { JsonSchema } from "@matthis-k/phenix-contracts/definitions.ts";
import type { ModelWorkflowProjection } from "@matthis-k/phenix-flow/workflow-projection.ts";
import type { AgentRole } from "@matthis-k/phenix-kernel/agents.ts";
import type { WorkflowExecutionBinding } from "@matthis-k/phenix-kernel/execution.ts";
import type { AgentClientRef } from "@matthis-k/phenix-kernel/refs.ts";
import type { ThinkingLevel } from "@matthis-k/phenix-kernel/task.ts";
import type { AssuranceLevel } from "../authority/types.ts";
import type { ToolBudget, TurnBudget } from "../subagents/agent-types.ts";
import type { ContractArtifact } from "../subagents/contract.ts";

declare const childRunIdBrand: unique symbol;
export type ChildRunId = string & { readonly [childRunIdBrand]: true };
export function childRunId(value: string): ChildRunId {
  return value as ChildRunId;
}

export interface PiSessionReference {
  readonly sessionId: string;
  readonly sessionFile?: string;
}

export type ChildSessionBackendKind = "sdk" | "rpc";
export type ChildTaskAuthoritySource = "workflow" | "runtime-internal";

export interface ConcreteModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface SerializedError {
  readonly code: string;
  readonly message: string;
  readonly cause?: string;
}

export type ChildSessionStatus =
  | "starting"
  | "running"
  | "settled"
  | "completed"
  | "failed"
  | "cancelled"
  | "disposed"
  | "orphaned";

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
  /** Ordinary workflow children claim a prepared task; runtime-owned children prepare at start. */
  readonly taskAuthoritySource?: ChildTaskAuthoritySource;
}

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
  readonly workflowProjection: ModelWorkflowProjection;
  readonly contractChannel: ContractSubmissionChannel;
  readonly parentContext: ChildParentExecutionContext;
  readonly effectiveTools: readonly string[];
  readonly skillRefs: readonly string[];
  readonly extensionRefs: readonly string[];
  readonly inheritProjectContext: boolean;
  /** Explicit derived assurance for adapter selection and diagnostics. */
  readonly assurance?: AssuranceLevel;
  /** True only when policy requires an operating-system process boundary. */
  readonly isolationRequired?: boolean;
  readonly timeoutMs: number;
  readonly turnBudget: TurnBudget;
  readonly toolBudget: ToolBudget;
  readonly persistence: "memory" | "file";
}

export type ContractResultState = "pending" | "submitted" | "accepted" | "cancelled";

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

export type ChildSessionEvent =
  | {
      readonly type: "session.started";
      readonly runId: ChildRunId;
      readonly pi: PiSessionReference;
    }
  | { readonly type: "agent.event"; readonly runId: ChildRunId; readonly event: unknown }
  | { readonly type: "tool.started"; readonly runId: ChildRunId; readonly toolName: string }
  | {
      readonly type: "tool.completed";
      readonly runId: ChildRunId;
      readonly toolName: string;
      readonly isError: boolean;
    }
  | { readonly type: "cycle.settled"; readonly runId: ChildRunId; readonly cycle: number }
  | {
      readonly type: "session.failed";
      readonly runId: ChildRunId;
      readonly error: SerializedError;
    }
  | { readonly type: "session.cancelled"; readonly runId: ChildRunId; readonly reason: string }
  | { readonly type: "session.disposed"; readonly runId: ChildRunId };

export interface ChildCycleOutcome {
  readonly cycle: number;
  readonly status: "settled" | "failed" | "cancelled";
  readonly lastAssistantText?: string;
  readonly error?: SerializedError;
}

export interface ChildRun {
  readonly id: ChildRunId;
  readonly backend: ChildSessionBackendKind;
  readonly pi: PiSessionReference;
  snapshot(): ChildSessionNode;
  subscribe(listener: (event: ChildSessionEvent) => void): () => void;
  continue(message: string, signal?: AbortSignal): Promise<ChildCycleOutcome>;
  waitForCurrentCycle(signal?: AbortSignal): Promise<ChildCycleOutcome>;
  abort(reason: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface ChildSessionBackend {
  readonly kind: ChildSessionBackendKind;
  start(spec: ChildSessionSpec, signal: AbortSignal): Promise<ChildRun>;
}

export interface PiRuntimeServices {
  readonly modelRegistry: unknown;
  readonly agentDir: string;
}

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
  | "ORPHANED_SESSION";

const CHILD_RUNTIME_ERROR_CODES: ReadonlySet<string> = new Set([
  "MODEL_NOT_FOUND",
  "MODEL_AUTH_UNAVAILABLE",
  "SESSION_START_FAILED",
  "PROMPT_REJECTED",
  "PROVIDER_FAILED",
  "CONTRACT_NOT_SUBMITTED",
  "CONTRACT_INVALID",
  "TURN_BUDGET_EXCEEDED",
  "TOOL_BUDGET_EXCEEDED",
  "TIMEOUT",
  "ABORTED",
  "VERIFICATION_FAILED",
  "CRITIC_REJECTED",
  "REPAIR_LIMIT_EXCEEDED",
  "ORPHANED_SESSION",
]);

export function isChildRuntimeErrorCode(value: unknown): value is ChildRuntimeErrorCode {
  return typeof value === "string" && CHILD_RUNTIME_ERROR_CODES.has(value);
}

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
  if (error instanceof Error) return { code: "PROVIDER_FAILED", message: error.message };
  return { code: "PROVIDER_FAILED", message: String(error) };
}
