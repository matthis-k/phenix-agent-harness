/**
 * phenix-kernel — shared execution protocol
 *
 * Defines the interaction between workflow and the execution coordinator
 * without making either import the other.
 *
 * This is a cross-domain protocol, not an implementation.
 */

import type {
  WorkflowActorId,
  WorkflowInstanceId,
  WorkflowTransitionId,
} from "./ids.ts";
import type { AgentClientRef, ContractDefinitionRef } from "./refs.ts";
import type { Difficulty, ThinkingLevel } from "./task.ts";

// ── Execution mode ──────────────────────────────────────────────────────────

export type AgentExecutionMode = "await" | "background";

// ── Workflow execution binding ──────────────────────────────────────────────

export interface WorkflowExecutionBinding {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly actorId: WorkflowActorId;
  readonly parentActorId?: WorkflowActorId;
  readonly transitionId: WorkflowTransitionId;
  readonly workflowRevision: number;
}

// ── Agent execution request ─────────────────────────────────────────────────

export interface AgentExecutionRequest {
  readonly agentClient: AgentClientRef;
  readonly difficulty: Difficulty;

  readonly task: string;
  readonly requirements: readonly string[];

  readonly inputContract?: ContractDefinitionRef;

  readonly outputContract: ContractDefinitionRef;

  readonly input?: unknown;
  readonly mode: AgentExecutionMode;

  readonly workflow: WorkflowExecutionBinding;
}

// ── Execution issue ─────────────────────────────────────────────────────────

export interface ExecutionIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code?: string;
}

// ── Agent execution result ─────────────────────────────────────────────────

export type AgentExecutionResult =
  | {
      readonly status: "completed";
      readonly handleId: string;
      readonly output: unknown;
    }
  | {
      readonly status: "output-invalid";
      readonly handleId: string;
      readonly issues: readonly ExecutionIssue[];
      readonly repairMessage: string;
    }
  | {
      readonly status: "failed";
      readonly handleId?: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly status: "cancelled";
      readonly handleId: string;
      readonly reason: string;
    };

// ── Agent execution port ────────────────────────────────────────────────────
//
// Legacy single-shot execution port. Retained for compatibility while the
// session-centric port below becomes the primary execution abstraction.

export interface AgentExecutionPort {
  execute(
    request: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult>;
}

// ── Agent session tree ──────────────────────────────────────────────────────
//
// A real child is an independently stateful agent session, not necessarily a
// separate process. These types model the session tree, lifecycle, and result
// shape independently of any execution backend. The kernel owns this vocabulary
// so workflow, routing, and the execution layer can share it without importing
// each other.

declare const agentSessionIdBrand: unique symbol;

/** Stable identity for a node in the agent session tree. */
export type AgentSessionId = string & {
  readonly [agentSessionIdBrand]: true;
};

/** Construct an AgentSessionId from a backend-provided run id. */
export function agentSessionId(value: string): AgentSessionId {
  return value as AgentSessionId;
}

/** Session lifecycle states. */
export type AgentSessionStatus =
  | "created"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Execution backend for a session. A process is only one possible backend; the
 * session owns the logical isolation, not the OS process.
 */
export type AgentSessionExecutionBackend =
  | "in-process"
  | "external-process"
  | "remote";

/** Opaque reference to a contract runtime instance held by the execution layer. */
export interface AgentSessionContractRef {
  readonly contractId: string;
  readonly runId: string;
  readonly role: string | null;
}
/** Backend-specific context attached to a session node. */
export interface AgentSessionContext {
  readonly cwd: string;
  readonly executionBackend: AgentSessionExecutionBackend;
  readonly runId?: string;
  readonly asyncDir?: string;
  readonly backend?: Readonly<Record<string, unknown>>;
}

/** A node in the agent session tree. */
export interface AgentSessionNode {
  readonly id: AgentSessionId;
  readonly parentId?: AgentSessionId;
  readonly rootId: AgentSessionId;

  readonly agentClient: AgentClientRef;
  readonly model?: string;
  readonly thinking: ThinkingLevel;

  readonly contract: AgentSessionContractRef;
  readonly workflowBinding?: WorkflowExecutionBinding;

  readonly context: AgentSessionContext;
  readonly status: AgentSessionStatus;
}

/** Result of running or resuming a session. */
export type AgentSessionResult =
  | {
      readonly status: "completed";
      readonly sessionId: AgentSessionId;
      readonly output: unknown;
    }
  | {
      readonly status: "waiting";
      readonly sessionId: AgentSessionId;
    }
  | {
      readonly status: "failed";
      readonly sessionId: AgentSessionId;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly status: "cancelled";
      readonly sessionId: AgentSessionId;
      readonly reason: string;
    };
