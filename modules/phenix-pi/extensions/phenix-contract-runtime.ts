import type {
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  authorizeContract,
} from "./phenix-subagents/contract.ts";
import {
  decodeContractBootstrapEnvironment,
  type ChildBootstrapEnvironment,
} from "./phenix-subagents/contract-identity.ts";
import {
  FileContractStore,
  ContractStoreError,
} from "./phenix-subagents/contract-store.ts";
import {
  validateContract,
} from "./phenix-subagents/contracts.ts";
import {
  deriveProjection,
  formatProjection,
} from "./phenix-subagents/contract-projection.ts";
import {
  initializeRuntimeContext,
  requireChildRuntimeContext,
} from "./phenix-subagents/contract-runtime-context.ts";
import {
  toolAllowedByConfig,
} from "./phenix-subagents/tool-policy.ts";

// ── phenix_complete parameters ──────────────────────────────────────────────

const CompleteParams = Type.Object(
  {
    value: Type.Unknown({
      description:
        "The complete structured result required by the active Phenix assignment.",
    }),
  },
  {
    additionalProperties: false,
  },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

function errorResult(
  message: string,
  details?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
    details: details ?? {
      status: "error",
    },
  };
}

/**
 * Validate that a stored contract artifact describes an executable contract.
 * Only minimal structural checks beyond the store decoder.
 */
function validateExecutableContract(
  _artifact: unknown,
): void {
  // The contract-store decoder already performs structural validation.
  // Additional runtime checks can be added here if needed.
}

// ── Bootstrap initialization ────────────────────────────────────────────────

async function bootstrapChild(
  pi: ExtensionAPI,
  env: ChildBootstrapEnvironment,
): Promise<void> {
  // 1. Load the contract from the store.
  const store = new FileContractStore(env.storeRoot);
  const stored = await store.load(env.identity.contractId);

  if (!stored) {
    throw new Error(
      `Phenix contract ${env.identity.contractId} was not found. ` +
      `Contract store root: ${env.storeRoot}`,
    );
  }

  // 2. Authorize the contract identity.
  const authorization = authorizeContract(
    stored.artifact,
    env.identity,
  );

  if (!authorization.ok) {
    throw new Error(
      `Phenix child bootstrap authorization failed: ${authorization.reason}.`,
    );
  }

  // 3. Validate the contract is executable.
  validateExecutableContract(stored.artifact);

  // 4. Initialize the process-local runtime context.
  //    This must happen before any model turn.
  initializeRuntimeContext({
    kind: "child",
    identity: env.identity,
    contract: stored.artifact,
    store,
  });

  // 5. Register the model-facing projection.
  //    Injects the safe task projection into the system prompt.
  registerContractPromptProjection(pi, stored);

  // 6. Register phenix_complete.
  //    The ONLY model-callable contract protocol tool.
  registerPhenixComplete(pi);

  // 7. Register the runtime tool guard.
  //    Ensures tool access matches the contract's effective configuration.
  registerContractToolGuard(pi);
}

// ── Prompt projection hook ──────────────────────────────────────────────────

function registerContractPromptProjection(
  pi: ExtensionAPI,
  stored: Awaited<ReturnType<FileContractStore["load"]>>,
): void {
  if (!stored) return;

  pi.on("before_agent_start", async (event) => {
    const projection = deriveProjection(stored.artifact);
    const formatted = formatProjection(projection);

    return {
      systemPrompt: `${event.systemPrompt}\n\n${formatted}`,
    };
  });
}

// ── Tool guard ──────────────────────────────────────────────────────────────

function registerContractToolGuard(
  pi: ExtensionAPI,
): void {
  pi.on("before_tool_call", async (event) => {
    const toolName = (event as { toolName?: string }).toolName ?? (event as { name?: string }).name;
    if (!toolName) return;

    // Always block raw subagent.
    if (toolName === "subagent") {
      return {
        blocked: true,
        reason: "Raw subagent calls are not allowed in Phenix child sessions.",
      };
    }

    // Block obsolete contract tools.
    if (
      toolName === "phenix_contract_get" ||
      toolName === "phenix_contract_submit"
    ) {
      return {
        blocked: true,
        reason: `The "${toolName}" tool is no longer available. Use phenix_complete to submit your result.`,
      };
    }

    // phenix_complete is always allowed for child sessions.
    if (toolName === "phenix_complete") return;

    // Check against contract effective tools.
    try {
      const ctx = requireChildRuntimeContext();
      if (!toolAllowedByConfig(ctx.contract.runtime.tools, toolName)) {
        return {
          blocked: true,
          reason: `Tool "${toolName}" is not authorized by the active contract.`,
        };
      }
    } catch {
      // Root sessions: no contract-based restrictions here.
      // The phenix-core tool guard handles root authorization.
    }
  });
}

// ── phenix_complete ─────────────────────────────────────────────────────────

function registerPhenixComplete(
  pi: ExtensionAPI,
): void {
  pi.registerTool({
    name: "phenix_complete",
    label: "Complete Phenix Assignment",
    description:
      "Submit the final structured result for the active Phenix child assignment. Validates against the output schema. Call this as the final action.",
    parameters: CompleteParams,

    async execute(
      _toolCallId: string,
      params: {
        value: unknown;
      },
      _signal: AbortSignal,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ) {
      const context = requireChildRuntimeContext();
      const store = context.store;
      const contract = context.contract;
      const id = contract.id;

      // Load current result state.
      const current = await store.load(id);

      if (!current) {
        return errorResult(
          `Contract ${id} was not found.`,
          {
            status: "not-found",
          },
        );
      }

      if (current.result.state !== "pending") {
        return errorResult(
          `Contract ${id} is already ${current.result.state}.`,
          {
            status: "already-terminal",
            state: current.result.state,
          },
        );
      }

      // Validate against the contract's output schema.
      const validation = validateContract(
        contract.assignment.outputSchema,
        params.value,
      );

      if (!validation.ok) {
        const summary =
          "summary" in validation
            ? validation.summary
            : "Contract validation failed.";

        return errorResult(
          [
            "Submission rejected.",
            summary,
            "Correct the value and call phenix_complete again.",
          ].join("\n"),
          {
            status: "invalid",
            validation,
          },
        );
      }

      // Atomically submit.
      try {
        const submitted = await store.submit(
          id,
          current.result.revision,
          params.value,
        );

        return {
          content: [
            {
              type: "text",
              text:
                "Assignment accepted. Delegated task complete.",
            },
          ],
          details: {
            status: "accepted",
            contractId: id,
            revision: submitted.revision,
          },
          terminate: true,
        };
      } catch (error) {
        if (error instanceof ContractStoreError) {
          return errorResult(
            error.message,
            {
              status: error.code,
            },
          );
        }

        throw error;
      }
    },
  });
}

// ── Default export (async bootstrap) ────────────────────────────────────────

export default async function phenixContractRuntime(
  pi: ExtensionAPI,
): Promise<void> {
  // Decode the bootstrap environment.
  // This throws on partial/invalid child environments.
  const envState = decodeContractBootstrapEnvironment();

  if (envState.kind === "root") {
    // Root process — no contract bootstrap needed.
    initializeRuntimeContext({ kind: "root" });
    return;
  }

  // Child process — bootstrap contract.
  await bootstrapChild(pi, envState);
}
