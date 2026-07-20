/** Pi-facing registration adapter for the Phenix subagent facade. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorizePhenixRootCapability, phenixRootModelScope } from "../composition/model-scope.ts";
import { createWorkflowApiTools } from "../runtime/workflow-api-tools.ts";
import { AgentParams } from "./delegate-schema.ts";
import type { SubagentHandleView } from "./facade.ts";
import { TERMINAL_STATES } from "./handle-types.ts";
import type { PhenixSubagentsOptions } from "./registration.ts";

function toolResult(record: SubagentHandleView): AgentToolResult<Record<string, unknown>> {
  const details = {
    id: record.id,
    handleId: record.id,
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

  pi.on("before_tool_call", async (event, ctx) => {
    if (!phenixRootModelScope.includes(ctx.model)) return;
    const raw = event as { toolName?: string; name?: string };
    const toolName = raw.toolName ?? raw.name;
    if (toolName === "subagent") {
      return {
        blocked: true,
        reason:
          "Unmanaged delegation is blocked in Phenix sessions. Use phenix_workflow; use phenix_subagent only when current authority enables it.",
      };
    }
  });

  for (const tool of createWorkflowApiTools({
    workflow: facade.workflow,
    authorize: ({ ctx, tool }) => authorizePhenixRootCapability({ ctx, capability: tool }),
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
      if (denial !== undefined) return fail(denial, { status: "forbidden", tool: "phenix_agent" });
      const params = rawParams as { action: "await" | "poll" | "cancel" | "inspect"; id: string };
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
