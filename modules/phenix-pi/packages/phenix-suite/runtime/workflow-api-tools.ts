/** Model-facing adapters for authority-bound workflow and subagent execution. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  DirectSubagentParams,
  type DirectSubagentParamsType,
  normalizeWorkflowRequirements,
  WorkflowActionParams,
  type WorkflowActionParamsType,
} from "./workflow-action-schema.ts";
import type { ParentExecutionContext } from "./workflow-api-types.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowHandleResult,
  WorkflowRuntimePort,
} from "./workflow-runtime-types.ts";

export const PHENIX_WORKFLOW_TOOL = "phenix_workflow" as const;
export const PHENIX_SUBAGENT_TOOL = "phenix_subagent" as const;
export type WorkflowApiToolName = typeof PHENIX_WORKFLOW_TOOL | typeof PHENIX_SUBAGENT_TOOL;

export interface WorkflowApiToolAuthorizationInput {
  readonly ctx: ExtensionContext;
  readonly tool: WorkflowApiToolName;
}

export type WorkflowApiToolAuthorizer = (
  input: WorkflowApiToolAuthorizationInput,
) => string | undefined;

export type RootUserTaskResolver = (ctx: ExtensionContext) => string | undefined;

function result(payload: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export class WorkflowToolError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkflowToolError";
    this.details = details ?? { status: "failed" };
  }
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new WorkflowToolError(message, details);
}

function authorizationResult(input: {
  readonly authorize?: WorkflowApiToolAuthorizer;
  readonly ctx: ExtensionContext;
  readonly tool: WorkflowApiToolName;
}): AgentToolResult<Record<string, unknown>> | undefined {
  const denial = input.authorize?.({ ctx: input.ctx, tool: input.tool });
  if (denial === undefined) return undefined;
  return fail(denial, { status: "forbidden", tool: input.tool });
}

function compactHandle(record: WorkflowHandleResult): Record<string, unknown> {
  return {
    handleId: record.id,
    status: record.status,
    value: record.value,
    error: record.errors?.join(" | "),
    errors: record.errors,
  };
}

/** Projection used by deterministic session bootstrap and model-facing inspection. */
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

async function spawn(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly parent?: ParentExecutionContext;
  readonly agent: string;
  readonly task: string;
  readonly userTask?: string;
  readonly requirements?: readonly string[] | string;
  readonly mode?: "await" | "background";
  readonly signal: AbortSignal | undefined;
  readonly ctx: ExtensionContext;
}): Promise<AgentToolResult<Record<string, unknown>>> {
  const requirements = normalizeWorkflowRequirements(input.requirements);
  const execution = await input.workflow.spawn({
    agent: input.agent,
    task: input.task,
    ...(input.userTask ? { userTask: input.userTask } : {}),
    ...(requirements && requirements.length > 0 ? { requirements } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.parent ? { parent: input.parent } : {}),
    signal: input.signal ?? new AbortController().signal,
    ctx: input.ctx,
  });
  if (!execution.ok) return fail(execution.message, execution.details);

  return result({
    ...execution.transition,
    ...compactHandle(execution.record),
  });
}

async function invokeWorkflowAction(input: {
  readonly params: WorkflowActionParamsType;
  readonly workflow: WorkflowRuntimePort;
  readonly parent?: ParentExecutionContext;
  readonly userTask?: string;
  readonly signal: AbortSignal | undefined;
  readonly ctx: ExtensionContext;
}): Promise<AgentToolResult<Record<string, unknown>>> {
  switch (input.params.action) {
    case "inspect":
      return result(
        projectWorkflowInspection(
          input.workflow.inspect({
            ctx: input.ctx,
            ...(input.parent ? { parent: input.parent } : {}),
          }),
        ),
      );

    case "spawn":
      return spawn({
        workflow: input.workflow,
        ...(input.parent ? { parent: input.parent } : {}),
        agent: input.params.agent,
        task: input.params.task,
        ...(input.userTask ? { userTask: input.userTask } : {}),
        ...(input.params.requirements !== undefined
          ? { requirements: input.params.requirements }
          : {}),
        ...(input.params.mode ? { mode: input.params.mode } : {}),
        signal: input.signal,
        ctx: input.ctx,
      });
  }
}

export function createWorkflowTool(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly parent?: ParentExecutionContext;
  readonly authorize?: WorkflowApiToolAuthorizer;
  readonly rootUserTask?: RootUserTaskResolver;
}): ToolDefinition<typeof WorkflowActionParams, Record<string, unknown>> {
  return {
    name: PHENIX_WORKFLOW_TOOL,
    label: "Phenix Workflow",
    description:
      "Inspect current workflow authority or spawn one advertised target agent. " +
      "Use this whenever the user explicitly requests workflow delegation or subagents. " +
      "The runtime derives the actor and current node from the active root session or initialized child contract, and owns transition selection, roles, routing, models, tools, child authority, contracts, assignments, and state changes.",
    parameters: WorkflowActionParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const forbidden = authorizationResult({
        authorize: input.authorize,
        ctx,
        tool: PHENIX_WORKFLOW_TOOL,
      });
      if (forbidden) return forbidden;

      try {
        return await invokeWorkflowAction({
          params,
          workflow: input.workflow,
          ...(input.parent ? { parent: input.parent } : {}),
          ...(!input.parent && input.rootUserTask ? { userTask: input.rootUserTask(ctx) } : {}),
          signal,
          ctx,
        });
      } catch (error) {
        if (error instanceof WorkflowToolError) throw error;
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function createDirectSubagentTool(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly parent?: ParentExecutionContext;
  readonly authorize?: WorkflowApiToolAuthorizer;
  readonly rootUserTask?: RootUserTaskResolver;
}): ToolDefinition<typeof DirectSubagentParams, Record<string, unknown>> {
  return {
    name: PHENIX_SUBAGENT_TOOL,
    label: "Phenix Subagent",
    description:
      "Spawn the sole legal contract-owned Phenix child directly. The tool is rejected whenever zero or multiple workflow targets are legal. " +
      "Normally use phenix_workflow instead. This tool never bypasses workflow contracts, routing, task-subtree ownership, or verification.",
    parameters: DirectSubagentParams,

    async execute(_toolCallId, params: DirectSubagentParamsType, signal, _onUpdate, ctx) {
      const forbidden = authorizationResult({
        authorize: input.authorize,
        ctx,
        tool: PHENIX_SUBAGENT_TOOL,
      });
      if (forbidden) return forbidden;

      try {
        const authority = input.workflow.inspect({
          ctx,
          ...(input.parent ? { parent: input.parent } : {}),
        });
        const availableAgents = authority.workflow.options.map((option) => option.agent);

        if (availableAgents.length !== 1) {
          return fail(
            "Direct Phenix subagent creation is available only when the current workflow node has exactly one legal target. Use phenix_workflow otherwise.",
            {
              code: "DIRECT_SUBAGENT_NOT_DETERMINISTIC",
              availableAgents,
            },
          );
        }

        const agent = params.agent ?? availableAgents[0];
        if (!agent) {
          return fail(
            "Direct subagent creation requires an agent because multiple targets are currently available.",
            {
              code: "DIRECT_SUBAGENT_TARGET_MISSING",
              availableAgents,
            },
          );
        }
        if (!availableAgents.includes(agent)) {
          return fail(`Agent ${agent} is not currently available.`, {
            code: "WORKFLOW_AGENT_NOT_AVAILABLE",
            availableAgents,
          });
        }

        return await spawn({
          workflow: input.workflow,
          ...(input.parent ? { parent: input.parent } : {}),
          agent,
          task: params.task,
          ...(!input.parent && input.rootUserTask ? { userTask: input.rootUserTask(ctx) } : {}),
          ...(params.requirements !== undefined ? { requirements: params.requirements } : {}),
          ...(params.mode ? { mode: params.mode } : {}),
          signal,
          ctx,
        });
      } catch (error) {
        if (error instanceof WorkflowToolError) throw error;
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function createWorkflowApiTools(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly parent?: ParentExecutionContext;
  readonly authorize?: WorkflowApiToolAuthorizer;
  readonly rootUserTask?: RootUserTaskResolver;
}): readonly ToolDefinition[] {
  return [
    createWorkflowTool(input) as unknown as ToolDefinition,
    createDirectSubagentTool(input) as unknown as ToolDefinition,
  ];
}
