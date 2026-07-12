/**
 * phenix-subagents — index
 *
 * Registers the root-visible phenix_delegate and phenix_agent tools.
 * Each child session receives its own closure-bound tools through
 * customTools — not process-global tools.
 *
 * Tool authorization is no longer duplicated between
 * phenix-contract-runtime.ts and this file. The root extension registers
 * root-visible tools; child sessions get closure-bound tools.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  type HandleRecord,
  TERMINAL_STATES,
} from "./handle-types.ts";
import {
  readRecord,
  listRecords,
  effectiveSessionId,
} from "./handle-store.ts";
import {
  DelegateParams,
  AgentParams,
} from "./delegate-schema.ts";
import { AgentExecutionCoordinator } from "./coordinator.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface PiEvents {
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
}

// ── Tool result helpers ─────────────────────────────────────────────────────

function toolResult(
  record: HandleRecord,
): AgentToolResult<Record<string, unknown>> {
  const min = {
    id: record.id,
    handleId: record.id,
    childRunId: record.childRunId,
    status: record.status,
    value: record.value,
    error: record.errors?.join(" | "),
    piSessionId: record.piSessionId,
    backend: record.backend,
    ...(record.producerSpec ? {
      role: record.producerSpec.role,
      agent: record.producerSpec.agent,
      model: record.producerSpec.model,
      thinking: record.producerSpec.thinking,
      tier: record.producerSpec.tier,
    } : {}),
  };
  const compact = JSON.stringify(min, null, 2);
  return {
    content: [
      {
        type: "text",
        text:
          compact.length > 500
            ? `${compact.slice(0, 497)}...`
            : compact,
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
    isError: true,
    details: details ?? { status: "failed" },
  };
}

// ── Tree payload ────────────────────────────────────────────────────────────

function treePayload(
  records: HandleRecord[],
): Record<string, unknown> {
  return {
    handles: records.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      status: r.status,
      role: r.producerSpec.role,
      agent: r.producerSpec.agent,
      cycles: r.producerCycles.length,
      childRunId: r.childRunId,
      piSessionId: r.piSessionId,
    })),
  };
}

// ── Extension entry point ───────────────────────────────────────────────────

export interface PhenixSubagentsOptions {
  readonly coordinator: AgentExecutionCoordinator;
}

export default async function phenixSubagents(
  pi: ExtensionAPI,
  options: PhenixSubagentsOptions,
): Promise<void> {
  const events = pi.events as unknown as PiEvents;
  const coordinator = options.coordinator;

  // ── Runtime tool guard ────────────────────────────────────────────────

  // Block raw subagent globally — only phenix_delegate is allowed.
  events.on("before_tool_call" as string, async (event: unknown) => {
    const raw = event as { toolName?: string; name?: string };
    const toolName = raw.toolName ?? raw.name;
    if (!toolName) return;

    if (toolName === "subagent") {
      return {
        blocked: true,
        reason:
          "Raw subagent calls are runtime-blocked in Phenix sessions. Use phenix_delegate instead.",
      };
    }

    // Block obsolete contract tools.
    if (
      toolName === "phenix_contract_get" ||
      toolName === "phenix_contract_submit"
    ) {
      return {
        blocked: true,
        reason:
          `Tool "${toolName}" is no longer available. Use phenix_complete to submit your result.`,
      };
    }
  });

  // ── phenix_delegate tool ──────────────────────────────────────────────

  pi.registerTool({
    name: "phenix_delegate",
    label: "Delegate Phenix Subagent",
    description:
      "Spawn a real isolated Pi subagent with a runtime-selected model and thinking level. " +
      "The output schema is enforced by the Phenix contract protocol. Tool access, verification " +
      "commands, critic gates, retry limits, persistence, and model routing are runtime-owned; " +
      "this tool intentionally exposes no override for them. Use mode=await by default. " +
      "Background mode is available only from the root session and returns a persistent handle.",
    parameters: DelegateParams,

    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal,
      _onUpdate:
        | ((result: AgentToolResult<Record<string, unknown>>) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      try {
        const result = await coordinator.delegate({
          params: rawParams as unknown as Parameters<typeof coordinator.delegate>[0]["params"],
          ctx,
          signal,
        });

        if (!result.ok) {
          return errorResult(result.message, result.details);
        }

        return toolResult(result.record);
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

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
      signal: AbortSignal,
      _onUpdate:
        | ((result: AgentToolResult<Record<string, unknown>>) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const params = rawParams as {
        action: "await" | "poll" | "cancel" | "inspect" | "tree";
        id?: string;
      };

      if (params.action === "tree") {
        const payload = treePayload(
          listRecords(ctx.cwd, effectiveSessionId(ctx)),
        );
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
        return errorResult(
          `phenix_agent action '${params.action}' requires id`,
        );
      }

      const record = readRecord(
        ctx.cwd,
        effectiveSessionId(ctx),
        params.id,
      );

      if (!record) {
        return errorResult(
          `Phenix handle not found: ${params.id}`,
        );
      }

      if (params.action === "inspect") return toolResult(record);

      if (params.action === "cancel") {
        const cancelled = await coordinator.cancelHandle(
          ctx,
          params.id,
          "cancelled by parent",
        );
        return toolResult(cancelled ?? record);
      }

      if (params.action === "poll") {
        const polled = await coordinator.poll(ctx, params.id);
        return toolResult(polled ?? record);
      }

      // await
      if (!TERMINAL_STATES.has(record.status)) {
        const resolved = await coordinator.awaitHandle(ctx, params.id, signal);
        return toolResult(resolved ?? record);
      }

      return toolResult(record);
    },
  });
}
