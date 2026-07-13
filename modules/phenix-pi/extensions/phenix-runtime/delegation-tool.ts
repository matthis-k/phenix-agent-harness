/**
 * delegation-tool — closure-bound phenix_delegate tool
 *
 * The tool receives workflow authority explicitly. It does not infer parent
 * identity or permissions from process-global state.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { DelegateParams, type DelegateParamsType } from "../phenix-subagents/delegate-schema.ts";
import type { WorkflowDecisionContext } from "../phenix-workflow/workflow-projection.ts";
import type { ChildParentExecutionContext } from "./child-session-types.ts";

export type ParentExecutionContext =
  | {
      readonly kind: "root";
      readonly sessionId: string;
      readonly cwd: string;
      readonly maximumDelegationDepth: number;
    }
  | ChildParentExecutionContext;

export type DelegateExecutionParams = DelegateParamsType;

export interface DelegateHandleResult {
  readonly id: string;
  readonly status: string;
  readonly value?: unknown;
  readonly errors?: readonly string[];
}

export type DelegateExecutionResult =
  | { readonly ok: true; readonly record: DelegateHandleResult }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

/** Minimal coordinator port required by the delegation tool. */
export interface DelegationCoordinator {
  delegate(input: {
    readonly params: DelegateExecutionParams;
    readonly parent: ParentExecutionContext;
    readonly signal: AbortSignal;
    readonly ctx: ExtensionContext;
  }): Promise<DelegateExecutionResult>;
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

/** Create one delegation tool bound to a specific parent and authority view. */
export function createDelegationTool(input: {
  readonly coordinator: DelegationCoordinator;
  readonly parent: ParentExecutionContext;
  readonly decisionContext: WorkflowDecisionContext;
}): ToolDefinition<typeof DelegateParams, Record<string, unknown>> {
  const { coordinator, parent, decisionContext } = input;

  return {
    name: "phenix_delegate",
    label: "Delegate Phenix Subagent",
    description:
      "Spawn a real isolated Pi subagent with a runtime-selected model and thinking level. " +
      "The output schema, tools, verification, critic gates, retry limits, persistence, " +
      "and routing are runtime-owned. Use mode=await by default. Background mode is " +
      "available only from the root session when the transition allows it.",
    parameters: DelegateParams,

    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      try {
        const matchingOption = decisionContext.options.find(
          (option) => option.transitionId === params.transitionId,
        );
        if (!matchingOption) {
          const availableIds = decisionContext.options
            .map((option) => option.transitionId)
            .join(", ");
          return errorResult(
            `phenix_delegate: transition "${params.transitionId}" is not currently available. ` +
              `Available transitions: ${availableIds || "(none)"}`,
            {
              state: decisionContext.currentState,
              revision: decisionContext.revision,
              available: decisionContext.options.map((option) => ({
                id: option.transitionId,
                role: option.role,
                category: option.category,
              })),
            },
          );
        }

        if (params.mode === "background" && parent.kind !== "root") {
          return errorResult(
            "phenix_delegate: background mode is only available from the root session.",
          );
        }

        if (params.mode === "background" && !matchingOption.allowedModes.includes("background")) {
          return errorResult(
            `phenix_delegate: background mode is not allowed for transition "${params.transitionId}". ` +
              `Allowed modes: ${matchingOption.allowedModes.join(", ")}.`,
          );
        }

        const result = await coordinator.delegate({
          params,
          parent,
          signal: signal ?? new AbortController().signal,
          ctx,
        });
        if (!result.ok) return errorResult(result.message, result.details);

        const compactRecord = {
          id: result.record.id,
          handleId: result.record.id,
          status: result.record.status,
          value: result.record.value,
          error: result.record.errors?.join(" | "),
        };
        const text = JSON.stringify(compactRecord, null, 2);
        return {
          content: [
            {
              type: "text",
              text: text.length > 500 ? `${text.slice(0, 497)}...` : text,
            },
          ],
          details: compactRecord,
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
