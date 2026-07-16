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

export interface WorkflowSpawnEdgeInput {
  readonly kind: "spawn";
  readonly task: string;
  readonly requirements?: string[];
  readonly mode?: "await" | "background";
}

/** Extend this union when the workflow gains another executable edge kind. */
export type WorkflowEdgeInput = WorkflowSpawnEdgeInput;

export interface WorkflowTakeEdgeRequest {
  readonly edgeId: string;
  readonly input: WorkflowEdgeInput;
  readonly parent?: ParentExecutionContext;
  readonly signal: AbortSignal;
  readonly ctx: ExtensionContext;
}

export type WorkflowEdgeExecutionResult =
  | {
      readonly ok: true;
      readonly edge: {
        readonly edgeId: string;
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
 * The model adapter never supplies actor or node state. The runtime derives both
 * from the active root session or child contract, then verifies the requested
 * edge against the freshly resolved outgoing edge set.
 */
export interface WorkflowRuntimePort {
  inspect(input: {
    readonly ctx: ExtensionContext;
    readonly parent?: ParentExecutionContext;
  }): WorkflowAuthoritySnapshot;

  takeEdge(input: WorkflowTakeEdgeRequest): Promise<WorkflowEdgeExecutionResult>;
}
