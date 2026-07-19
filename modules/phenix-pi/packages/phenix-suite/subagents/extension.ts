/**
 * phenix-subagents — composition entry point
 *
 * Registers the root-visible workflow API and bounded handle operations. Each
 * child session receives closure-bound tools through customTools rather than
 * process-global tools.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorizePhenixRootCapability, phenixRootModelScope } from "../composition/model-scope.ts";
import { createWorkflowApiTools } from "../runtime/workflow-api-tools.ts";
import { AgentParams } from "./delegate-schema.ts";
import { effectiveSessionId, readRecord } from "./handle-store.ts";
import { type HandleRecord, TERMINAL_STATES } from "./handle-types.ts";
import type { PhenixSubagentsOptions } from "./registration.ts";

function toolResult(record: HandleRecord): AgentToolResult<Record<string, unknown>> {
  const min = {
    id: record.id,
    handleId: record.id,
    subagentId: record.subagentId,
    status: record.status,
    value: record.value,
    error: record.errors?.join(" | "),
    modelSet: record.modelSet,
    ...(record.producerSpec
      ? {
          role: record.producerSpec.role,
          agent: record.producerSpec.agent,
          model: record.producerSpec.model,
          thinking: record.producerSpec.thinking,
          tier: record.producerSpec.tier,
        }
      : {}),
  };
  const compact = JSON.stringify(min, null, 2);
  return {
    content: [
      {
        type: "text",
        text: compact.length > 500 ? `${compact.slice(0, 497)}...` : compact,
      },
    ],
    details: min as Record<string, unknown>,
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

export default async function phenixSubagents(
  pi: ExtensionAPI,
  options: PhenixSubagentsOptions,
): Promise<void> {
  const delegator = options.delegator;
  const workflow = options.workflow;

  // Unmanaged delegation is blocked only for directly selected Phenix
  // root models. Other root models retain their native tool semantics.
  pi.on("before_tool_call", async (event, ctx) => {
    if (!phenixRootModelScope.includes(ctx.model)) return;

    const raw = event as { toolName?: string; name?: string };
    const toolName = raw.toolName ?? raw.name;
    if (!toolName) return;

    if (toolName === "subagent") {
      return {
        blocked: true,
        reason:
          "Unmanaged delegation is runtime-blocked in Phenix sessions. Use phenix_workflow with action=spawn, one target agent advertised in the preloaded authority snapshot, and a bounded task.",
      };
    }
  });

  // Root tools are globally registered by Pi, but execution is authorized by
  // the root-model scope. Child tools are closure-bound and omit this authorizer.
  for (const tool of createWorkflowApiTools({
    workflow,
    authorize: ({ ctx, tool: toolName }) =>
      authorizePhenixRootCapability({ ctx, capability: toolName }),
  })) {
    pi.registerTool(tool as never);
  }

  pi.registerTool({
    name: "phenix_agent",
    label: "Phenix Agent Handle",
    description: "Inspect, await, poll, or cancel one known Phenix execution handle.",
    parameters: AgentParams,

    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: ((result: AgentToolResult<Record<string, unknown>>) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const denial = authorizePhenixRootCapability({ ctx, capability: "phenix_agent" });
      if (denial !== undefined) {
        return errorResult(denial, { status: "forbidden", tool: "phenix_agent" });
      }

      const params = rawParams as {
        action: "await" | "poll" | "cancel" | "inspect";
        id: string;
      };
      const record = readRecord(ctx.cwd, effectiveSessionId(ctx), params.id);

      if (!record) {
        return errorResult(`Phenix handle not found: ${params.id}`);
      }

      if (params.action === "inspect") return toolResult(record);

      if (params.action === "cancel") {
        const cancelled = await delegator.cancelHandle(ctx, params.id, "cancelled by parent");
        return toolResult(cancelled ?? record);
      }

      if (params.action === "poll") {
        const polled = await delegator.poll(ctx, params.id);
        return toolResult(polled ?? record);
      }

      if (!TERMINAL_STATES.has(record.status)) {
        const resolved = await delegator.awaitHandle(
          ctx,
          params.id,
          signal ?? new AbortController().signal,
        );
        return toolResult(resolved ?? record);
      }

      return toolResult(record);
    },
  });
}
