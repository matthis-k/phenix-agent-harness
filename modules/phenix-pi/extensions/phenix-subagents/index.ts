import { randomUUID } from "node:crypto";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  isAgentKind,
  type AgentKind,
  type AgentRole,
} from "./agent-types.ts";
import {
  resolveChildSpec,
  type ResolvedChildSpec,
  type ContractCreatorContext,
} from "./child-spec.ts";
import {
  SubagentBackend,
} from "./backend.ts";
import {
  runAttempt,
} from "./attempt-runner.ts";
import {
  type HandleRecord,
  HANDLE_VERSION,
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
import {
  type JsonSchema,
  assertOutputSchema,
} from "./contracts.ts";
import {
  DelegateParams,
  AgentParams,
} from "./delegate-schema.ts";
import type { Details } from "pi-subagents/src/shared/types.ts";
import { getRuntimeContext } from "./contract-runtime-context.ts";
import { toolAllowedByConfig } from "./tool-policy.ts";

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

// ── Handle lifecycle ────────────────────────────────────────────────────────

function createHandle(
  ctx: ExtensionContext,
  producerSpec: ResolvedChildSpec,
  criticSpec: ResolvedChildSpec | undefined,
  task: string,
  requirements: readonly string[],
  outputSchema: Record<string, unknown>,
  parentId?: string,
): HandleRecord {
  return {
    version: HANDLE_VERSION,
    id: randomUUID(),
    sessionId: effectiveSessionId(ctx),
    parentId,
    assignment: {
      task,
      requirements: [...requirements],
      outputSchema,
    },
    producerSpec,
    ...(criticSpec ? { criticSpec } : {}),
    createdAt: now(),
    updatedAt: now(),
    status: "running",
    attempts: [],
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
        const params = rawParams as {
          role: AgentRole;
          task: string;
          outputSchema: JsonSchema;
          requirements?: string[];
          tools?: {
            additional?: string[];
            removed?: string[];
          } | null;
          profile?: {
            complexity?: number;
            uncertainty?: number;
            consequence?: number;
            breadth?: number;
            coupling?: number;
            novelty?: number;
          };
          mode?: "await" | "background";
          model?: string;
          cwd?: string;
          parent?: string;
        };

        // Validate role.
        if (params.role === undefined) {
          return errorResult(
            "phenix_delegate: role is required",
          );
        }
        if (params.role !== null && !isAgentKind(params.role)) {
          return errorResult(
            `phenix_delegate: invalid role "${params.role}"`,
          );
        }

        // Validate output schema.
        assertOutputSchema(params.outputSchema);

        const requirements = params.requirements ?? [];
        const cwd = params.cwd ?? ctx.cwd;

        // Determine creator context.
        const runtimeCtx = getRuntimeContext();
        let creator: ContractCreatorContext;

        if (runtimeCtx?.kind === "child") {
          creator = {
            kind: "child",
            contract: runtimeCtx.contract,
          };

          // Enforce: parent must allow child role.
          const allowed = runtimeCtx.contract.runtime.allowedChildren;
          if (params.role !== null && !allowed.includes(params.role as AgentKind)) {
            return errorResult(
              `Role "${params.role}" is not an allowed child role in the current contract.`,
            );
          }

          // Enforce remaining delegation depth.
          if (runtimeCtx.contract.runtime.remainingDelegationDepth <= 0) {
            return errorResult(
              "Delegation depth exhausted. No further children may be spawned.",
            );
          }
        } else {
          creator = {
            kind: "root",
            maximumDelegationDepth: 2,
          };
        }

        // Resolve producer child spec.
        const producerSpec = resolveChildSpec({
          role: params.role,
          task: params.task,
          requirements,
          outputSchema: params.outputSchema,
          profileHint: params.profile,
          tools: params.tools,
          cwd,
          creator,
          model: params.model,
        });

        // Resolve critic spec if required (independent resolution).
        let criticSpec: ResolvedChildSpec | undefined;
        if (producerSpec.criticRequired) {
          const criticTask = `Review the completed assignment for: ${params.task.slice(0, 200)}`;

          criticSpec = resolveChildSpec({
            role: "critic",
            task: criticTask,
            requirements,
            outputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["verdict", "summary", "findings", "missingRequirements"],
              properties: {
                verdict: { enum: ["approve", "reject"] },
                summary: { type: "string", minLength: 1 },
                findings: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["severity", "description", "evidence"],
                    properties: {
                      severity: { enum: ["minor", "major", "critical"] },
                      description: { type: "string", minLength: 1 },
                      evidence: { type: "string", minLength: 1 },
                      requirement: { type: "string" },
                    },
                  },
                },
                missingRequirements: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
              },
            },
            tools: {
              additional: [],
              removed: [],
            },
            cwd,
            creator: {
              kind: "runtime-internal",
              maximumDelegationDepth: 0,
            },
          });
        }

        // Create handle record.
        const parentId = params.parent;
        const record = createHandle(
          ctx,
          producerSpec,
          criticSpec,
          params.task,
          requirements,
          params.outputSchema,
          parentId,
        );

        const isBackground = params.mode === "background";

        if (isBackground) {
          // Background: write record and return handle.
          writeRecord(ctx.cwd, record);

          // Start execution in background.
          runAttempt(backend, ctx, signal, record).catch(() => {
            // Errors captured in record.
          });

          return toolResult(record);
        }

        // Foreground: await completion.
        const runnerResult = await runAttempt(
          backend,
          ctx,
          signal,
          record,
        );

        return toolResult(runnerResult.record);
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
