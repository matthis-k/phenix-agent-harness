/**
 * workflow-api-tools — model-facing deterministic workflow API
 *
 * Every Phenix actor receives one stable workflow tool. Its discriminated
 * actions are resolved against fresh root or contract-bound authority before
 * any state change or child execution is allowed.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ModelWorkflowProjection } from "../phenix-workflow/workflow-projection.ts";
import {
  WorkflowActionParams,
  type WorkflowDelegateActionType,
} from "./workflow-action-schema.ts";
import type { ParentExecutionContext } from "./workflow-api-types.ts";

export const PHENIX_WORKFLOW_TOOL = "phenix_workflow" as const;
export type WorkflowApiToolName = typeof PHENIX_WORKFLOW_TOOL;

export interface WorkflowApiToolAuthorizationInput {
  readonly ctx: ExtensionContext;
  readonly tool: WorkflowApiToolName;
}

/** Return a denial message, or undefined when the invocation is in scope. */
export type WorkflowApiToolAuthorizer = (
  input: WorkflowApiToolAuthorizationInput,
) => string | undefined;

/** Internal authority snapshot. The tool sanitizes this before model exposure. */
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

export interface WorkflowDelegationExecutionParams {
  readonly transitionId: string;
  readonly task: string;
  readonly requirements?: readonly string[];
  readonly mode?: "await" | "background";
  readonly workflowRevision: number;
  readonly authorityDigest: string;
}

/** Minimal authoritative workflow surface required by the model-facing adapter. */
export interface WorkflowApiPort {
  inspect(input: {
    readonly ctx: ExtensionContext;
    readonly parent?: ParentExecutionContext;
  }): WorkflowAuthoritySnapshot;

  delegate(input: {
    readonly params: WorkflowDelegationExecutionParams;
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

function authorizationResult(input: {
  readonly authorize?: WorkflowApiToolAuthorizer;
  readonly ctx: ExtensionContext;
}): AgentToolResult<Record<string, unknown>> | undefined {
  const denial = input.authorize?.({ ctx: input.ctx, tool: PHENIX_WORKFLOW_TOOL });
  if (denial === undefined) return undefined;
  return errorResult(denial, { status: "forbidden", tool: PHENIX_WORKFLOW_TOOL });
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

/** Public actor-scoped authority view; internal transition identities are omitted. */
export function projectWorkflowInspection(
  snapshot: WorkflowAuthoritySnapshot,
): Record<string, unknown> {
  return {
    actor: {
      source: snapshot.source,
      role: snapshot.role,
    },
    state: {
      id: snapshot.workflow.currentState,
      difficulty: snapshot.workflow.difficulty,
      revision: snapshot.workflow.revision,
    },
    authority: {
      remainingDelegationDepth: snapshot.delegation.remainingDepth,
      effectiveTools: [...snapshot.effectiveTools],
    },
    actions: {
      delegate: snapshot.workflow.options.map((option) => ({
        agent: option.agent,
        role: option.role,
        purpose: option.purpose,
        description: option.description,
        category: option.category,
        modes: [...option.allowedModes],
        returns: {
          schemaId: option.outputSchemaId,
          schema: option.resultSchema,
        },
      })),
    },
  };
}

function availableAgentDetails(snapshot: WorkflowAuthoritySnapshot): readonly Record<string, unknown>[] {
  return snapshot.workflow.options.map((option) => ({
    agent: option.agent,
    role: option.role,
    category: option.category,
    modes: [...option.allowedModes],
  }));
}

async function delegateThroughWorkflow(input: {
  readonly params: WorkflowDelegateActionType;
  readonly workflow: WorkflowApiPort;
  readonly parent?: ParentExecutionContext;
  readonly signal: AbortSignal | undefined;
  readonly ctx: ExtensionContext;
}): Promise<AgentToolResult<Record<string, unknown>>> {
  const snapshot = input.workflow.inspect({
    ctx: input.ctx,
    ...(input.parent ? { parent: input.parent } : {}),
  });
  const option = snapshot.workflow.options.find(
    (candidate) => candidate.agent === input.params.agent,
  );

  if (!option) {
    return errorResult(
      `phenix_workflow: agent "${input.params.agent}" is not currently available to ` +
        `${snapshot.role} in state "${snapshot.workflow.currentState}".`,
      {
        code: "WORKFLOW_AGENT_NOT_AVAILABLE",
        role: snapshot.role,
        state: snapshot.workflow.currentState,
        revision: snapshot.workflow.revision,
        availableAgents: availableAgentDetails(snapshot),
      },
    );
  }

  if (input.params.mode === "background" && input.parent?.kind === "child") {
    return errorResult("phenix_workflow: background delegation is only available to the root actor.");
  }
  if (
    input.params.mode === "background" &&
    !option.allowedModes.includes("background")
  ) {
    return errorResult(
      `phenix_workflow: background mode is not allowed for agent "${input.params.agent}".`,
      {
        code: "WORKFLOW_MODE_NOT_ALLOWED",
        agent: option.agent,
        allowedModes: [...option.allowedModes],
      },
    );
  }

  const execution = await input.workflow.delegate({
    params: {
      transitionId: option.transitionId,
      task: input.params.task,
      ...(input.params.requirements ? { requirements: input.params.requirements } : {}),
      ...(input.params.mode ? { mode: input.params.mode } : {}),
      workflowRevision: snapshot.workflow.revision,
      authorityDigest: snapshot.workflow.optionsDigest,
    },
    ...(input.parent ? { parent: input.parent } : {}),
    signal: input.signal ?? new AbortController().signal,
    ctx: input.ctx,
  });
  if (!execution.ok) return errorResult(execution.message, execution.details);
  return result(compactHandle(execution.record));
}

export function createWorkflowTool(input: {
  readonly workflow: WorkflowApiPort;
  readonly parent?: ParentExecutionContext;
  readonly authorize?: WorkflowApiToolAuthorizer;
}): ToolDefinition<typeof WorkflowActionParams, Record<string, unknown>> {
  return {
    name: PHENIX_WORKFLOW_TOOL,
    label: "Phenix Workflow",
    description:
      "Inspect current workflow authority or delegate through an actor-scoped agent action. " +
      "The runtime owns roles, routing, models, tools, child authority, contracts, and state transitions.",
    parameters: WorkflowActionParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const forbidden = authorizationResult({ authorize: input.authorize, ctx });
      if (forbidden) return forbidden;

      try {
        if (params.action === "inspect") {
          const snapshot = input.workflow.inspect({
            ctx,
            ...(input.parent ? { parent: input.parent } : {}),
          });
          return result(projectWorkflowInspection(snapshot));
        }

        return await delegateThroughWorkflow({
          params,
          workflow: input.workflow,
          ...(input.parent ? { parent: input.parent } : {}),
          signal,
          ctx,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Build the exact workflow interface installed during actor initialization. */
export function createWorkflowApiTools(input: {
  readonly workflow: WorkflowApiPort;
  readonly parent?: ParentExecutionContext;
  readonly authorize?: WorkflowApiToolAuthorizer;
  /** Transitional composition input; one workflow tool is always installed. */
  readonly allowCreate?: boolean;
}): readonly ToolDefinition[] {
  return [createWorkflowTool(input) as unknown as ToolDefinition];
}
