/**
 * phenix-kernel — shared execution protocol
 *
 * Defines the interaction between workflow and the execution coordinator
 * without making either import the other.
 *
 * This is a cross-domain protocol, not an implementation.
 *
 * Only stable, serializable domain types live here. No Pi runtime types
 * (AgentSession, RpcClient, etc.) are imported.
 */

import type {
  WorkflowActorId,
  WorkflowInstanceId,
  WorkflowTransitionId,
} from "./ids.ts";
import type { AgentClientRef, ContractDefinitionRef } from "./refs.ts";
import type { Difficulty } from "./task.ts";

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
