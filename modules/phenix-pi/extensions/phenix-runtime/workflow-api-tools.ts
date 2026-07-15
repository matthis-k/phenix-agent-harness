/**
 * workflow-api-tools — model-facing deterministic workflow API
 *
 * Every Phenix model receives a workflow inspection function. A contract-bound
 * child receives the creation function only when its initialized contract may
 * delegate. Revision and authority digests are never supplied by the model;
 * they are read immediately before creation and bound by the runtime.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  WorkflowCreateParams,
  type WorkflowCreateParamsType,
  WorkflowInspectParams,
} from "../phenix-subagents/delegate-schema.ts";
import type { ModelWorkflowProjection } from "../phenix-workflow/workflow-projection.ts";
import type { ParentExecutionContext } from "./workflow-api-types.ts";

export const PHENIX_WORKFLOW_TOOL = "phenix_workflow" as const;
export const PHENIX_CREATE_SUBAGENT_TOOL = "phenix_create_subagent" as const;

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

export interface WorkflowApiHandleResult {
  readonly id: string;
  readonly status: string;
  readonly value?: unknown;
  readonly errors?: readonly string[];
}

export type WorkflowApiExecutionResult =
  | { readonly ok: true; readonly record: WorkflowApiHandleResult }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

/** Minimal authoritative workflow surface required by model-facing tools. */
export interface WorkflowApiPort {
  inspect(input: {
    readonly ctx: ExtensionContext;
    readonly parent?: ParentExecutionContext;
  }): WorkflowAuthoritySnapshot;

  delegate(input: {
    readonly params: WorkflowCreateParamsType & {
      readonly workflowRevision: number;
      readonly authorityDigest: string;
    };
    readonly parent?: ParentExecutionContext;
    readonly signal: AbortSignal;
    readonly ctx: ExtensionContext;
  }): Promise<WorkflowApiExecutionResult>;
}

function result(payload: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function errorResult(
  message: string,
  details?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    details: details ?? { status: "failed" },
  };
}

function compactHandle(record: WorkflowApiHandleResult): Record<string, unknown> {
  return {
    id: record.id,
    handleId: record.id,
    status: record.status,
    value: record.value,
    error: record.errors?.join(" | "),
  };
}

export function createWorkflowInspectTool(input: {
  readonly workflow: WorkflowApiPort;
  readonly parent?: ParentExecutionContext;
}): ToolDefinition<typeof WorkflowInspectParams, Record<string, unknown>> {
  return {
    name: PHENIX_WORKFLOW_TOOL,
    label: "Inspect Phenix Workflow",
    description:
      "Return the exact current workflow state and contract-derived subagent creation authority. " +
      "Call this before creating a subagent; its transitions are the runtime source of truth.",
    parameters: WorkflowInspectParams,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const snapshot = input.workflow.inspect({
          ctx,
          ...(input.parent ? { parent: input.parent } : {}),
        });
        return result(snapshot as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function createWorkflowSubagentTool(input: {
  readonly workflow: WorkflowApiPort;
  readonly parent?: ParentExecutionContext;
}): ToolDefinition<typeof WorkflowCreateParams, Record<string, unknown>> {
  return {
    name: PHENIX_CREATE_SUBAGENT_TOOL,
    label: "Create Phenix Subagent",
    description:
      "Create one isolated subagent through a currently legal Phenix workflow transition. " +
      "Call phenix_workflow first. The runtime binds the current revision and authority digest, " +
      "then selects the role, model, thinking level, output contract, tools, budgets, and gates.",
    parameters: WorkflowCreateParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const snapshot = input.workflow.inspect({
          ctx,
          ...(input.parent ? { parent: input.parent } : {}),
        });
        const option = snapshot.workflow.options.find(
          (candidate) => candidate.transitionId === params.transitionId,
        );
        if (!option) {
          return errorResult(
            `phenix_create_subagent: transition "${params.transitionId}" is not currently legal. ` +
              "Call phenix_workflow and select one of its current transitions.",
            {
              state: snapshot.workflow.currentState,
              revision: snapshot.workflow.revision,
              available: snapshot.workflow.options.map((candidate) => ({
                transitionId: candidate.transitionId,
                role: candidate.role,
                category: candidate.category,
                allowedModes: candidate.allowedModes,
              })),
            },
          );
        }

        if (params.mode === "background" && input.parent?.kind === "child") {
          return errorResult(
            "phenix_create_subagent: background mode is only available to the root workflow.",
          );
        }
        if (params.mode === "background" && !option.allowedModes.includes("background")) {
          return errorResult(
            `phenix_create_subagent: background mode is not allowed for transition "${params.transitionId}".`,
          );
        }

        const execution = await input.workflow.delegate({
          params: {
            ...params,
            workflowRevision: snapshot.workflow.revision,
            authorityDigest: snapshot.workflow.optionsDigest,
          },
          ...(input.parent ? { parent: input.parent } : {}),
          signal: signal ?? new AbortController().signal,
          ctx,
        });
        if (!execution.ok) return errorResult(execution.message, execution.details);
        return result(compactHandle(execution.record));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Build the exact workflow API installed during model/session initialization. */
export function createWorkflowApiTools(input: {
  readonly workflow: WorkflowApiPort;
  readonly parent?: ParentExecutionContext;
  readonly allowCreate: boolean;
}): readonly ToolDefinition[] {
  return [
    createWorkflowInspectTool(input) as unknown as ToolDefinition,
    ...(input.allowCreate ? [createWorkflowSubagentTool(input) as unknown as ToolDefinition] : []),
  ];
}
