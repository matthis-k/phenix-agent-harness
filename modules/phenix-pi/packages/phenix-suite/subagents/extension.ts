/** Pi-facing registration adapter for the Phenix subagent facade. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import { authorizePhenixRootCapability, phenixRootModelScope } from "../composition/model-scope.ts";
import { createWorkflowApiTools } from "../runtime/workflow-api-tools.ts";
import { subscribeManagedBackgroundSettlements } from "./background-settlement-channel.ts";
import { AgentParams, type AgentParamsType } from "./delegate-schema.ts";
import type { SubagentHandleView } from "./facade.ts";
import { effectiveSessionId } from "./handle-store.ts";
import { TERMINAL_STATES } from "./handle-types.ts";
import type { PhenixSubagentsOptions } from "./registration.ts";

function toolResult(record: SubagentHandleView): AgentToolResult<Record<string, unknown>> {
  const details = {
    id: record.id,
    handleId: record.id,
    handle: {
      id: record.id,
      tool: "phenix_agent",
      actions: ["inspect", "poll", "await", "send", "cancel"],
    },
    subagentId: record.subagentId,
    status: record.status,
    value: record.value,
    error: record.errors?.join(" | "),
    modelSet: record.modelSet,
    role: record.role,
    agent: record.agent,
    model: record.model,
    thinking: record.thinking,
    tier: record.tier,
  };
  const compact = JSON.stringify(details, null, 2);
  return {
    content: [
      { type: "text", text: compact.length > 500 ? `${compact.slice(0, 497)}...` : compact },
    ],
    details,
  };
}

function fail(message: string, details?: Record<string, unknown>): never {
  const error = new Error(message) as Error & { details?: Record<string, unknown> };
  error.details = details ?? { status: "failed" };
  throw error;
}

export default async function phenixSubagents(
  pi: ExtensionAPI,
  options: PhenixSubagentsOptions,
): Promise<void> {
  const facade = options.facade;
  let activeSessionId: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    activeSessionId = effectiveSessionId(ctx);
  });

  const unsubscribeBackgroundSettlements = subscribeManagedBackgroundSettlements(
    ({ sessionId: settledSessionId, record }) => {
      if (activeSessionId !== settledSessionId) return;

      const details = {
        handleId: record.id,
        subagentId: record.subagentId,
        status: record.status,
        value: record.value,
        errors: record.errors,
      };
      pi.sendMessage(
        {
          customType: "phenix-background-settled",
          content: [
            `Phenix background delegation ${record.id} settled with status ${record.status}.`,
            `Call phenix_agent with action=await and id=${JSON.stringify(record.id)} to reconcile the workflow gate and collect the persisted handoff, then continue the existing parent task.`,
            "Do not spawn a replacement child.",
            JSON.stringify(details, null, 2),
          ].join("\n"),
          display: true,
          details,
        },
        {
          deliverAs: "steer",
          triggerTurn: true,
        },
      );
    },
  );

  pi.on("tool_call", async (event, ctx) => {
    if (!phenixRootModelScope.includes(ctx.model)) return;
    const id = effectiveSessionId(ctx);

    if (event.toolName === "subagent") {
      return {
        block: true,
        reason:
          "Unmanaged delegation is blocked in Phenix sessions. Use phenix_workflow; use phenix_subagent only when current authority enables it.",
      };
    }

    const denial = options.workflowGate.authorize({
      sessionId: id,
      turnId: getSessionRuntime(id).currentTurnId,
      toolName: event.toolName,
      input: event.input,
    });
    return denial === undefined ? undefined : { block: true, reason: denial };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!phenixRootModelScope.includes(ctx.model)) return;
    const isWorkflowSpawn = event.toolName === "phenix_workflow" && event.input.action === "spawn";
    const isHandleLifecycle = event.toolName === "phenix_agent";
    if (!isWorkflowSpawn && !isHandleLifecycle) return;

    const id = effectiveSessionId(ctx);
    let isError = event.isError;
    let authorityResolved = false;
    let currentState: string | undefined;
    let nextRequiredAgents: readonly string[] = [];
    try {
      const workflow = facade.workflow.inspect({ ctx }).workflow;
      authorityResolved = true;
      currentState = workflow.currentState;
      nextRequiredAgents = workflow.options
        .filter((option) => option.category === "required")
        .map((option) => option.agent);
    } catch {
      if (!isError) isError = true;
    }

    const rawDetails = (event as { readonly details?: unknown }).details;
    const details =
      typeof rawDetails === "object" && rawDetails !== null && !Array.isArray(rawDetails)
        ? (rawDetails as Readonly<Record<string, unknown>>)
        : {};
    const resultHandleId =
      typeof details.handleId === "string"
        ? details.handleId
        : typeof details.id === "string"
          ? details.id
          : undefined;
    const handleStatus = typeof details.status === "string" ? details.status : undefined;

    options.workflowGate.observe({
      sessionId: id,
      turnId: getSessionRuntime(id).currentTurnId,
      toolName: event.toolName,
      input: event.input,
      isError,
      authorityResolved,
      ...(currentState ? { currentState } : {}),
      nextRequiredAgents,
      ...(resultHandleId ? { handleId: resultHandleId } : {}),
      ...(handleStatus ? { handleStatus } : {}),
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    activeSessionId = undefined;
    unsubscribeBackgroundSettlements();
    options.workflowGate.clearSession(effectiveSessionId(ctx));
  });

  for (const tool of createWorkflowApiTools({
    workflow: facade.workflow,
    authorize: ({ ctx, tool }) => authorizePhenixRootCapability({ ctx, capability: tool }),
    rootUserTask: (ctx) => getSessionRuntime(effectiveSessionId(ctx)).currentUserTask,
  })) {
    pi.registerTool(tool as never);
  }

  pi.registerTool({
    name: "phenix_agent",
    label: "Phenix Agent Handle",
    description:
      "Inspect, poll, await, steer, or cancel one known Phenix execution handle. Use action=send to provide a concise clarification to a live child.",
    parameters: AgentParams,
    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: ((result: AgentToolResult<Record<string, unknown>>) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const denial = authorizePhenixRootCapability({ ctx, capability: "phenix_agent" });
      if (denial !== undefined) return fail(denial, { status: "forbidden", tool: "phenix_agent" });
      const params = rawParams as AgentParamsType;
      const record = facade.inspectHandle(ctx, params.id);
      if (!record) return fail(`Phenix handle not found: ${params.id}`);
      if (params.action === "inspect") return toolResult(record);
      if (params.action === "cancel") {
        return toolResult(
          (await facade.cancelHandle(ctx, params.id, "cancelled by parent")) ?? record,
        );
      }
      if (params.action === "poll")
        return toolResult((await facade.pollHandle(ctx, params.id)) ?? record);
      if (params.action === "send") {
        return toolResult(
          (await facade.sendHandle(
            ctx,
            params.id,
            params.message,
            signal ?? new AbortController().signal,
          )) ?? record,
        );
      }
      if (!TERMINAL_STATES.has(record.status)) {
        return toolResult(
          (await facade.awaitHandle(ctx, params.id, signal ?? new AbortController().signal)) ??
            record,
        );
      }
      return toolResult(record);
    },
  });
}
