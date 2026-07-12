/**
 * completion-tool — closure-bound phenix_complete tool
 *
 * The tool closes over the exact contract channel for one child run.
 * It does not discover its contract through environment variables,
 * process-global state, or a "current child" singleton.
 *
 * Behavior:
 * 1. Obtain the active contract attempt from its channel.
 * 2. Validate the submitted value against the active output schema.
 * 3. Return a normal tool error with exact validation issues when invalid.
 * 4. Leave the agent running after invalid output so it can repair immediately.
 * 5. Atomically record valid output as "submitted".
 * 6. Return terminate: true only after a valid submission is stored.
 * 7. Say "submission received" rather than claiming final acceptance.
 *
 * Final acceptance belongs to deterministic runtime verification and
 * critic gates, not this tool.
 */

import { Type } from "typebox";
import { validateSchema } from "../phenix-contracts/validator.ts";
import type {
  ContractSubmissionChannel,
  ContractSubmissionResult,
  ExecutionIssue,
} from "./child-session-types.ts";

// ── Completion tool parameters ──────────────────────────────────────────────

const CompleteParams = Type.Object(
  {
    value: Type.Unknown({
      description: "The complete structured result required by the active Phenix assignment.",
    }),
  },
  {
    additionalProperties: false,
  },
);

// ── Minimal tool definition (structural — no Pi import required) ────────────

export interface MinimalToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<AgentToolResult>;
}

// ── AgentToolResult (structural — avoids Pi import) ──────────────────────────

interface AgentToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
  readonly details?: Record<string, unknown>;
  readonly terminate?: boolean;
}

function errorResult(message: string, details?: Record<string, unknown>): AgentToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: details ?? { status: "error" },
  };
}

function issuesToExecutionIssues(
  violations: readonly { readonly path: string; readonly message: string }[],
): readonly ExecutionIssue[] {
  return violations.map((v) => ({
    path: v.path.split("."),
    message: v.message,
  }));
}

// ── Completion tool factory ─────────────────────────────────────────────────

/**
 * Create a closure-bound phenix_complete tool for one child run.
 *
 * The channel is specific to the child run's contract. No process-global
 * state is consulted.
 */
export function createCompletionTool(channel: ContractSubmissionChannel): MinimalToolDefinition {
  return {
    name: "phenix_complete",
    label: "Complete Phenix Assignment",
    description:
      "Submit the final structured result for the active Phenix child assignment. " +
      "Validates against the output schema. Call this as the final action. " +
      "If validation fails, correct the reported fields and call again. " +
      "A successful call records your submission; final acceptance is determined " +
      "by runtime verification and critic gates.",
    parameters: CompleteParams,

    async execute(
      _toolCallId: string,
      params: { value: unknown },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ): Promise<AgentToolResult> {
      const attempt = channel.current();

      // Check if the contract is still in a submittable state.
      if (attempt.state === "accepted") {
        return errorResult(
          "This assignment has already been accepted. No further submission is needed.",
          { status: "already-accepted", contractId: attempt.contractId },
        );
      }

      if (attempt.state === "cancelled") {
        return errorResult("This assignment has been cancelled.", {
          status: "cancelled",
          contractId: attempt.contractId,
        });
      }

      if (attempt.state === "submitted") {
        return errorResult(
          "A submission is already under evaluation. " +
            "Wait for runtime feedback before submitting again.",
          { status: "already-submitted", contractId: attempt.contractId },
        );
      }

      // Validate against the contract's output schema.
      const validation = validateSchema(attempt.outputSchema, params.value);

      if (!validation.ok) {
        const issues = issuesToExecutionIssues(validation.violations);
        return errorResult(
          [
            "Submission rejected — output does not match the required schema.",
            validation.summary,
            "Correct the value and call phenix_complete again.",
          ].join("\n"),
          {
            status: "invalid",
            contractId: attempt.contractId,
            issues,
          },
        );
      }

      // Atomically submit valid output.
      const result: ContractSubmissionResult = await channel.submit(params.value);

      if (!result.ok) {
        return errorResult(`Submission could not be recorded: state is ${result.state}.`, {
          status: "rejected",
          contractId: attempt.contractId,
          state: result.state,
          ...(result.issues ? { issues: result.issues } : {}),
        });
      }

      // terminate: true only after a valid submission is stored.
      // Say "submission received" — do NOT claim final acceptance.
      return {
        content: [
          {
            type: "text",
            text:
              "Submission received. The runtime will now validate, verify, and " +
              "optionally review your work. Continue if you receive repair feedback.",
          },
        ],
        details: {
          status: "submitted",
          contractId: attempt.contractId,
          revision: result.revision,
        },
        terminate: true,
      };
    },
  };
}
