/**
 * phenix-subagents — index
 *
 * Registers the root-visible workflow API and phenix_agent tools.
 * Each child session receives its own closure-bound tools through
 * customTools — not process-global tools.
 *
 * Tool authorization is no longer duplicated between
 * phenix-contract-runtime.ts and this file. The root extension registers
 * root-visible tools; child sessions get closure-bound tools.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowApiTools,
  type WorkflowApiPort,
} from "../phenix-runtime/workflow-api-tools.ts";
import { AgentParams } from "./delegate-schema.ts";
import { effectiveSessionId, listRecords, readRecord } from "./handle-store.ts";
import { type HandleRecord, TERMINAL_STATES } from "./handle-types.ts";
import type { WorkflowDelegator } from "./workflow-delegator.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface PiEvents {
  on(event: string, handler: (payload: unknown) => void): (() => void) | undefined;
}

// ── Tool result helpers ─────────────────────────────────────────────────────

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

// ── Tree payload ────────────────────────────────────────────────────────────

function treePayload(records: HandleRecord[]): Record<string, unknown> {
  return {
    handles: records.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      status: r.status,
      role: r.producerSpec.role,
      agent: r.producerSpec.agent,
      cycles: r.producerCycles.length,
      subagentId: r.subagentId,
      rootSubagentId: r.rootSubagentId,
    })),
  };
}

// ── Extension entry point ───────────────────────────────────────────────────

export interface PhenixSubagentsOptions {
  readonly delegator: WorkflowDelegator;
  readonly workflow: WorkflowApiPort;
}

export default async function phenixSubagents(
  pi: ExtensionAPI,
  options: PhenixSubagentsOptions,
): Promise<void> {
  const events = pi.events as unknown as PiEvents;
  const delegator = options.delegator;
  const workflow = options.workflow;

  // ── Runtime tool guard ────────────────────────────────────────────────

  // Block raw and legacy delegation globally — only the workflow API is allowed.
  events.on("before_tool_call" as string, async (event: unknown) => {
    const raw = event as { toolName?: string; name?: string };
    const toolName = raw.toolName ?? raw.name;
    if (!toolName) return;

    if (toolName === "subagent" || toolName === "phenix_delegate") {
      return {
        blocked: true,
        reason:
          "Raw or legacy delegation is runtime-blocked in Phenix sessions. Call phenix_workflow, then phenix_create_subagent.",
      };
    }

    // Block obsolete contract tools.
    if (toolName === "phenix_contract_get" || toolName === "phenix_contract_submit") {
      return {
        blocked: true,
        reason: `Tool "${toolName}" is no longer available. Use phenix_complete to submit your result.`,
      };
    }
  });

  // ── Contract-bound workflow API ────────────────────────────────────────

  for (const tool of createWorkflowApiTools({ workflow, allowCreate: true })) {
    pi.registerTool(tool as never);
  }

  // ── phenix_agent tool ─────────────────────────────────────────────────

  pi.registerTool({
    name: "phenix_agent",
    label: "Phenix Agent",
    description:
      "Inspect, await, poll, cancel, or display the persistent tree of Phenix subagent handles.",
    parameters: AgentParams,

    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: ((result: AgentToolResult<Record<string, unknown>>) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const params = rawParams as {
        action: "await" | "poll" | "cancel" | "inspect" | "tree";
        id?: string;
      };

      if (params.action === "tree") {
        const payload = treePayload(listRecords(ctx.cwd, effectiveSessionId(ctx)));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
          details: payload,
        };
      }

      if (!params.id) {
        return errorResult(`phenix_agent action '${params.action}' requires id`);
      }

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

      // await
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
