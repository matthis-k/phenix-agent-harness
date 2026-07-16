/** Model-facing adapter for the authority-bound workflow runtime. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { WorkflowActionParams, type WorkflowActionParamsType } from "./workflow-action-schema.ts";
import type { ParentExecutionContext } from "./workflow-api-types.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowHandleResult,
  WorkflowRuntimePort,
} from "./workflow-runtime-types.ts";

export const PHENIX_WORKFLOW_TOOL = "phenix_workflow" as const;
export type WorkflowApiToolName = typeof PHENIX_WORKFLOW_TOOL;

export interface WorkflowApiToolAuthorizationInput {
  readonly ctx: ExtensionContext;
  readonly tool: WorkflowApiToolName;
}

export type WorkflowApiToolAuthorizer = (
  input: WorkflowApiToolAuthorizationInput,
) => string | undefined;

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

function compactHandle(record: WorkflowHandleResult): Record<string, unknown> {
  return {
    handleId: record.id,
    status: record.status,
    value: record.value,
    error: record.errors?.join(" | "),
  };
}

/** Projection used by deterministic session bootstrap and diagnostics. */
export function projectWorkflowInspection(
  snapshot: WorkflowAuthoritySnapshot,
): Record<string, unknown> {
  return {
    actor: {
      source: snapshot.source,
      role: snapshot.role,
    },
    node: {
      nodeId: snapshot.workflow.currentState,
      difficulty: snapshot.workflow.difficulty,
      revision: snapshot.workflow.revision,
    },
    agents: snapshot.workflow.options.map((option) => ({
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
    authority: {
      remainingDelegationDepth: snapshot.delegation.remainingDepth,
      effectiveTools: [...snapshot.effectiveTools],
    },
  };
}

async function invokeWorkflowAction(input: {
  readonly params: WorkflowActionParamsType;
  readonly workflow: WorkflowRuntimePort;
  readonly parent?: ParentExecutionContext;
  readonly signal: AbortSignal | undefined;
  readonly ctx: ExtensionContext;
}): Promise<AgentToolResult<Record<string, unknown>>> {
  switch (input.params.action) {
    case "spawn": {
      const execution = await input.workflow.spawn({
        agent: input.params.agent,
        task: input.params.task,
        ...(input.params.requirements ? { requirements: input.params.requirements } : {}),
        ...(input.params.mode ? { mode: input.params.mode } : {}),
        ...(input.parent ? { parent: input.parent } : {}),
        signal: input.signal ?? new AbortController().signal,
        ctx: input.ctx,
      });
      if (!execution.ok) return errorResult(execution.message, execution.details);

      return result({
        ...execution.transition,
        ...compactHandle(execution.record),
      });
    }
  }
}

export function createWorkflowTool(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly parent?: ParentExecutionContext;
  readonly authorize?: WorkflowApiToolAuthorizer;
}): ToolDefinition<typeof WorkflowActionParams, Record<string, unknown>> {
  return {
    name: PHENIX_WORKFLOW_TOOL,
    label: "Phenix Workflow",
    description:
      "Perform one workflow action using the authority snapshot injected at session start. " +
      "For spawning, provide one advertised target agent and a bounded task. The runtime derives the current node and owns transition selection, roles, routing, models, tools, child authority, contracts, and state changes.",
    parameters: WorkflowActionParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const forbidden = authorizationResult({ authorize: input.authorize, ctx });
      if (forbidden) return forbidden;

      try {
        return await invokeWorkflowAction({
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

export function createWorkflowApiTools(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly parent?: ParentExecutionContext;
  readonly authorize?: WorkflowApiToolAuthorizer;
}): readonly ToolDefinition[] {
  return [createWorkflowTool(input) as unknown as ToolDefinition];
}
