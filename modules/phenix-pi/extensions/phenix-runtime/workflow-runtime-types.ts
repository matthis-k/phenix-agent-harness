import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ModelWorkflowProjection } from "../phenix-workflow/workflow-projection.ts";
import type { ParentExecutionContext } from "./workflow-api-types.ts";

export interface WorkflowAuthoritySnapshot {
  readonly source: "root" | "contract";
  readonly role: string;
  readonly effectiveTools: readonly string[];
  readonly delegation: {
    readonly remainingDepth: number;
    readonly effectiveRoles: readonly string[];
    readonly availableRoles: readonly string[];
  };
  readonly workflow: ModelWorkflowProjection;
}

export interface WorkflowHandleResult {
  readonly id: string;
  readonly status: string;
  readonly value?: unknown;
  readonly errors?: readonly string[];
}

export interface WorkflowSpawnRequest {
  readonly agent: string;
  readonly task: string;
  readonly requirements?: string[];
  readonly mode?: "await" | "background";
  readonly parent?: ParentExecutionContext;
  readonly signal: AbortSignal;
  readonly ctx: ExtensionContext;
}

export type WorkflowSpawnResult =
  | {
      readonly ok: true;
      readonly transition: {
        readonly agent: string;
        readonly fromNodeId: string;
        readonly toNodeId: string;
      };
      readonly record: WorkflowHandleResult;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

/**
 * Authority-bound workflow application service.
 *
 * The model adapter supplies only a target agent and assignment. The runtime
 * derives actor and node state from the active root session or child contract,
 * resolves the unique legal transition for that target, and executes it.
 */
export interface WorkflowRuntimePort {
  inspect(input: {
    readonly ctx: ExtensionContext;
    readonly parent?: ParentExecutionContext;
  }): WorkflowAuthoritySnapshot;

  spawn(input: WorkflowSpawnRequest): Promise<WorkflowSpawnResult>;
}
