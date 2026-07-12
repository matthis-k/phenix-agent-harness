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
import {
  PHENIX_DEFAULT_WORKFLOW,
  buildChildWorkflowProjection,
} from "./phenix-workflow/index.ts";
import type {
  WorkflowRuntimeRecord,
  DelegationAuthority,
} from "./phenix-workflow/workflow-types.ts";
import type { AgentRole } from "./phenix-subagents/agent-types.ts";

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

// ── Bootstrap initialization ────────────────────────────────────────────────

const PHENIX_TEST_BOOTSTRAP_EVIDENCE_ENV = "PHENIX_TEST_BOOTSTRAP_EVIDENCE";

export function formatChildBootstrapEvidence(input: {
  readonly contractId: string;
  readonly runId: string;
  readonly role: string | null;
}): string {
  return [
    "PHENIX_CHILD_BOOTSTRAP",
    `contractId=${input.contractId}`,
    `runId=${input.runId}`,
    `role=${input.role ?? "base"}`,
  ].join(" ");
}

function shouldEmitBootstrapEvidence(): boolean {
  const value = process.env[PHENIX_TEST_BOOTSTRAP_EVIDENCE_ENV];
  return value === "1" || value === "true" || value === "yes";
}

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

  // 3. Initialize the process-local runtime context.
  initializeRuntimeContext({
    kind: "child",
    identity: env.identity,
    contract: stored.artifact,
    store,
  });

  const bootstrapEvidence = formatChildBootstrapEvidence({
    contractId: stored.artifact.id,
    runId: env.identity.runId,
    role: stored.artifact.identity.role,
  });

  if (shouldEmitBootstrapEvidence()) {
    console.error(bootstrapEvidence);
  }

  // 4. Register the model-facing projection.
  registerContractPromptProjection(pi, stored, bootstrapEvidence);

  // 5. Register phenix_complete.
  registerPhenixComplete(pi);

  // 6. Register the runtime tool guard.
  registerContractToolGuard(pi);
}

// ── Prompt projection hook ──────────────────────────────────────────────────

function registerContractPromptProjection(
  pi: ExtensionAPI,
  stored: Awaited<ReturnType<FileContractStore["load"]>>,
  bootstrapEvidence: string,
): void {
  if (!stored) return;

  // Pre-compute the child's DelegationAuthority from the contract.
  const contract = stored.artifact;
  const authority: DelegationAuthority = {
    roles: {
      presetRevision: 1,
      role: contract.identity.role,
      source: { inherited: true, patch: { additional: [], removed: [] } },
      effective:
        contract.runtime.delegation.roles.effective as unknown as AgentRole[],
    },
    availableRoles:
      contract.runtime.delegation.roles.effective as unknown as AgentRole[],
    remainingDepth: contract.runtime.delegation.remainingDepth,
    transitionAuthority: contract.runtime.workflow.transitionAuthority,
  };

  pi.on("before_agent_start", async (event) => {
    // Build a synthetic workflow runtime record from the contract.
    const runtime: WorkflowRuntimeRecord = {
      version: 1,
      instanceId: contract.runtime.workflow.instanceId,
      actorId: contract.runtime.workflow.actorId,
      parentActorId: contract.runtime.workflow.parentActorId,
      sessionId: "",
      definitionId: "phenix-default",
      definitionVersion: 1,
      difficulty: contract.runtime.workflow.difficulty,
      taskProfile: {
        complexity: 1,
        uncertainty: 1,
        consequence: 1,
        breadth: 1,
        coupling: 1,
        novelty: 1,
      },
      actorRole: (contract.identity.role ?? "base") as WorkflowRuntimeRecord["actorRole"],
      state: contract.runtime.workflow.initialState,
      revision: 0,
      facts: {},
      active: [],
      completed: [],
      capabilityArtifactHash: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const workflowProjection = buildChildWorkflowProjection({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime,
      authority,
      activeHandles: [],
    });

    const projection = deriveProjection(contract, workflowProjection);
    const formatted = formatProjection(projection);
    const evidenceSection = shouldEmitBootstrapEvidence()
      ? `## Phenix child bootstrap evidence\n\n${bootstrapEvidence}\n\n`
      : "";

    return {
      systemPrompt: `${event.systemPrompt}\n\n${evidenceSection}${formatted}`,
    };
  });
}

// ── Tool guard ──────────────────────────────────────────────────────────────

function registerContractToolGuard(
  pi: ExtensionAPI,
): void {
  pi.on("before_tool_call", async (event) => {
    const toolName =
      (event as { toolName?: string }).toolName ??
      (event as { name?: string }).name;
    if (!toolName) return;

    // Always block raw subagent.
    if (toolName === "subagent") {
      return {
        blocked: true,
        reason:
          "Raw subagent calls are not allowed in Phenix child sessions.",
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
          `The "${toolName}" tool is no longer available. Use phenix_complete to submit your result.`,
      };
    }

    // phenix_complete is always allowed for child sessions.
    if (toolName === "phenix_complete") return;

    // Check against contract effective tools.
    try {
      const ctx = requireChildRuntimeContext();
      if (
        !toolAllowedByConfig(
          ctx.contract.runtime.tools,
          toolName,
        )
      ) {
        return {
          blocked: true,
          reason:
            `Tool "${toolName}" is not authorized by the active contract.`,
        };
      }
    } catch {
      // Root sessions: no contract-based restrictions here.
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
  const envState = decodeContractBootstrapEnvironment();

  if (envState.kind === "root") {
    // Root process — no contract bootstrap needed.
    initializeRuntimeContext({ kind: "root" });
    return;
  }

  // Child process — bootstrap contract.
  await bootstrapChild(pi, envState);
}
