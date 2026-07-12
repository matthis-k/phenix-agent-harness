/**
 * delegation-tool — closure-bound phenix_delegate tool
 *
 * The tool receives all authority explicitly. It does not infer parent
 * identity or permissions from global state. Its presented options and
 * accepted runtime options derive from the same WorkflowDecisionContext
 * and digest already introduced in the repository.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRole } from "../phenix-kernel/agents.ts";
import { DelegateParams } from "../phenix-subagents/delegate-schema.ts";
import type { WorkflowDecisionContext } from "../phenix-workflow/workflow-projection.ts";
import type { MinimalToolDefinition } from "./completion-tool.ts";

interface AgentToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
  readonly details?: Record<string, unknown>;
}

// ── Parent execution context ────────────────────────────────────────────────

/**
 * The parent's execution context, passed explicitly to the delegation tool.
 *
 * Replaces process-global current-child detection. Each child session
 * receives its own delegation tool with its own parent context.
 */
export interface ParentExecutionContext {
  readonly kind: "root" | "child";
  readonly sessionId: string;
  readonly cwd: string;
  readonly contractId?: string;
  readonly handleId?: string;
  readonly childRunId?: string;
  readonly rootChildRunId?: string;
  readonly modelSet?: string;
  readonly maximumDelegationDepth: number;
}

// ── Delegate execution result ───────────────────────────────────────────────

export interface DelegateExecutionParams {
  readonly transitionId: string;
  readonly workflowRevision: number;
  readonly authorityDigest?: string;
  readonly task: string;
  readonly requirements?: readonly string[];
  readonly tools?: {
    readonly additional?: readonly string[];
    readonly removed?: readonly string[];
  } | null;
  readonly delegateRoles?: {
    readonly additional?: readonly AgentRole[];
    readonly removed?: readonly AgentRole[];
  } | null;
  readonly mode?: "await" | "background";
}

export type DelegateExecutionResult =
  | { readonly ok: true; readonly record: unknown }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

// ── Coordinator interface (to avoid circular import) ────────────────────────

/**
 * Minimal interface the delegation tool needs from the coordinator.
 * The real AgentExecutionCoordinator implements this.
 */
export interface DelegationCoordinator {
  delegate(input: {
    readonly params: DelegateExecutionParams;
    readonly parent: ParentExecutionContext;
    readonly signal: AbortSignal;
    readonly ctx: ExtensionContext;
  }): Promise<DelegateExecutionResult>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function errorResult(
  message: string,
  details?: Record<string, unknown>,
): AgentToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: details ?? { status: "failed" },
  };
}

// ── Delegation tool factory ─────────────────────────────────────────────────

/**
 * Create a closure-bound phenix_delegate tool for one parent context.
 *
 * The coordinator, parent context, and decision context are all passed
 * explicitly. No global state is consulted.
 */
export function createDelegationTool(input: {
  readonly coordinator: DelegationCoordinator;
  readonly parent: ParentExecutionContext;
  readonly decisionContext: WorkflowDecisionContext;
}): MinimalToolDefinition {
  const { coordinator, parent, decisionContext } = input;

  return {
    name: "phenix_delegate",
    label: "Delegate Phenix Subagent",
    description:
      "Spawn a real isolated Pi subagent with a runtime-selected model and thinking level. " +
      "The output schema is enforced by the Phenix contract protocol. " +
      "Tool access, verification commands, critic gates, retry limits, persistence, " +
      "and model routing are runtime-owned; this tool intentionally exposes no override for them. " +
      "Use mode=await by default. Background mode is available only from the root session " +
      "and returns a persistent handle.",
    parameters: DelegateParams,

    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal,
      _onUpdate: unknown,
      rawContext: unknown,
    ): Promise<AgentToolResult> {
      try {
        const params = rawParams as unknown as DelegateExecutionParams;

        // Validate transitionId is among the projected options.
        if (
          typeof params.transitionId !== "string" ||
          params.transitionId.length === 0
        ) {
          return errorResult(
            "phenix_delegate: transitionId is required. Select one from the projected delegation options.",
          );
        }

        const matchingOption = decisionContext.options.find(
          (o) => o.transitionId === params.transitionId,
        );

        if (!matchingOption) {
          const availableIds = decisionContext.options.map(
            (o) => o.transitionId,
          ).join(", ");
          return errorResult(
            `phenix_delegate: transition "${params.transitionId}" is not currently available. ` +
            `Available transitions: ${availableIds || "(none)"}`,
            {
              state: decisionContext.currentState,
              revision: decisionContext.revision,
              available: decisionContext.options.map((o) => ({
                id: o.transitionId,
                role: o.role,
                category: o.category,
              })),
            },
          );
        }

        // Background mode restriction — only root can use background.
        if (
          params.mode === "background" &&
          parent.kind !== "root"
        ) {
          return errorResult(
            `phenix_delegate: background mode is only available from the root session.`,
          );
        }

        if (
          params.mode === "background" &&
          !matchingOption.allowedModes.includes("background")
        ) {
          return errorResult(
            `phenix_delegate: background mode is not allowed for transition "${params.transitionId}". ` +
            `Allowed modes: ${matchingOption.allowedModes.join(", ")}.`,
          );
        }

        const result = await coordinator.delegate({
          params,
          parent,
          signal,
          ctx: rawContext as ExtensionContext,
        });

        if (!result.ok) {
          return errorResult(result.message, result.details);
        }

        // Return a compact representation of the handle.
        const record = result.record as {
          readonly id: string;
          readonly status: string;
          readonly value?: unknown;
          readonly errors?: readonly string[];
        };

        const min = {
          id: record.id,
          handleId: record.id,
          status: record.status,
          value: record.value,
          error: record.errors?.join(" | "),
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
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
