import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  SubagentBackend,
} from "./backend.ts";
import {
  runAttempt,
} from "./attempt-runner.ts";
import {
  type HandleRecord,
  TERMINAL_STATES,
} from "./handle-types.ts";
import {
  writeRecord,
  readRecord,
  listRecords,
  latestAttempt,
  effectiveSessionId,
  now,
} from "./handle-store.ts";
import type { Details } from "pi-subagents/src/shared/types.ts";
import {
  DelegateParams,
  AgentParams,
} from "./delegate-schema.ts";
import {
  getRuntimeContext,
} from "./contract-runtime-context.ts";
import { toolAllowedByConfig } from "./tool-policy.ts";
import { AgentExecutionCoordinator } from "./coordinator.ts";


// ── Types ───────────────────────────────────────────────────────────────────

interface PiEvents {
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
  emit(event: string, payload: unknown): void;
}

// ── Tool result helpers ─────────────────────────────────────────────────────

function toolResult(
  record: HandleRecord,
): AgentToolResult<Record<string, unknown>> {
  const attempt = latestAttempt(record);
  const min = {
    id: record.id,
    handleId: record.id,
    runId: attempt?.runId,
    status: record.status,
    value: record.value,
    error: record.errors?.join(" | "),
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
      attempts: r.attempts.length,
    })),
  };
}

// ── Handle resolution for await/poll ────────────────────────────────────────

async function resolveBackground(
  backend: SubagentBackend,
  ctx: ExtensionContext,
  signal: AbortSignal,
  record: HandleRecord,
  awaitCompletion: boolean,
): Promise<HandleRecord> {
  // Already terminal — nothing to do.
  if (TERMINAL_STATES.has(record.status)) return record;

  const attempt = latestAttempt(record);
  if (attempt.status !== "running") {
    // Check if there's a pending attempt that's still running.
    const lastAttempt = record.attempts.at(-1);
    if (!lastAttempt || lastAttempt.status !== "running") return record;
  }

  if (!awaitCompletion) {
    // Just poll once — check if result file exists.
    const attempt = latestAttempt(record);
    if (!attempt.asyncDir) return record;
    try {
      const result = backend.readResult(attempt.runId);
      if (!result) return record;
    } catch {
      return record;
    }
  }

  // Run the full attempt runner (idempotent — will skip completed/cancelled).
  const runnerResult = await runAttempt(backend, ctx, signal, record);
  return runnerResult.record;
}

// ── Extension entry point ───────────────────────────────────────────────────

export default async function phenixSubagents(
  pi: ExtensionAPI,
): Promise<void> {
  const events = pi.events as unknown as PiEvents;
  const backend = new SubagentBackend(pi);
  const coordinator = new AgentExecutionCoordinator(backend);

  // ── Runtime tool guard ────────────────────────────────────────────────

  // Block raw subagent and obsolete contract tools globally.
  events.on("before_tool_call" as string, async (event: unknown) => {
    const raw = event as { toolName?: string; name?: string };
    const toolName = raw.toolName ?? raw.name;
    if (!toolName) return;

    // Always block raw subagent.
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

    // In child session, enforce contract tool authorization.
    const runtimeCtx = getRuntimeContext();
    if (runtimeCtx?.kind === "child") {
      const contract = runtimeCtx.contract;

      // phenix_complete is always allowed for child sessions.
      if (toolName === "phenix_complete") return;

      if (!toolAllowedByConfig(contract.runtime.tools, toolName)) {
        return {
          blocked: true,
          reason:
            `Tool "${toolName}" is not authorized by the active Phenix contract.`,
        };
      }
    }
  });

  // ── phenix_delegate tool ──────────────────────────────────────────────

  pi.registerTool({
    name: "phenix_delegate",
    label: "Delegate Phenix Subagent",
    description:
      "Spawn a real isolated Pi subagent with a runtime-selected model and thinking level. The output schema is enforced by the Phenix contract protocol. Tool access, verification commands, critic gates, retry limits, persistence, and model routing are runtime-owned; this tool intentionally exposes no override for them. Use mode=await by default. Background mode is available only from the root session and returns a persistent handle.",
    parameters: DelegateParams,

    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal,
      _onUpdate:
        | ((result: AgentToolResult<Details>) => void)
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
        | ((result: AgentToolResult<Details>) => void)
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
        if (!TERMINAL_STATES.has(record.status)) {
          const attempt = latestAttempt(record);
          try {
            await backend.interrupt(attempt.runId, signal);
          } catch {
            await backend.stop(attempt.runId, signal).catch(() => undefined);
          }
          attempt.status = "cancelled";
          attempt.endedAt = now();
          record.status = "cancelled";
          record.errors = ["cancelled by parent"];
          writeRecord(ctx.cwd, record);
        }
        return toolResult(record);
      }

      // await / poll
      if (
        record.status === "running" &&
        latestAttempt(record).mode === "background"
      ) {
        const resolved = await resolveBackground(
          backend,
          ctx,
          signal,
          record,
          params.action === "await",
        );
        return toolResult(resolved);
      }

      return toolResult(record);
    },
  });
}
