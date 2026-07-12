import path from "node:path";

import {
  validateContract,
} from "./contracts.ts";
import {
  PHENIX_CONTRACT_ID_ENV,
  PHENIX_CONTRACT_TOKEN_ENV,
  PHENIX_CONTRACT_STORE_ENV,
  PHENIX_RUN_ID_ENV,
} from "./contract-identity.ts";
import {
  createRunId,
  issueContract,
  type ContractArtifact,
  type ContractId,
  type RunId,
} from "./contract.ts";
import {
  FileContractStore,
} from "./contract-store.ts";
import {
  findProjectRoot,
} from "./handle-store.ts";
import {
  ACCEPTANCE_RANK,
  type Evaluation,
  type HandleRecord,
} from "./handle-types.ts";
import type {
  ResolvedChildSpec,
} from "./child-spec.ts";

// ── Contract store helper ───────────────────────────────────────────────────

function contractsForCwd(cwd: string): FileContractStore {
  return new FileContractStore(
    path.join(
      findProjectRoot(cwd),
      ".phenix-agent-state",
      "contracts",
    ),
  );
}

// ── Contract evaluation ─────────────────────────────────────────────────────

export async function evaluateContractResult(
  contractId: ContractId,
  cwd: string,
): Promise<{
  readonly ok: boolean;
  readonly value?: unknown;
  readonly errors: readonly string[];
  readonly contract: "valid" | "invalid" | "missing" | "cancelled";
}> {
  const stored = await contractsForCwd(cwd).load(contractId);

  if (!stored) {
    return {
      ok: false,
      errors: [`Contract artifact ${contractId} is missing.`],
      contract: "missing",
    };
  }

  if (stored.result.state === "pending") {
    return {
      ok: false,
      errors: ["Child exited without completing its Phenix contract."],
      contract: "missing",
    };
  }

  if (stored.result.state === "cancelled") {
    return {
      ok: false,
      errors: [`Contract was cancelled: ${stored.result.reason}`],
      contract: "cancelled",
    };
  }

  // Use the schema from the stored artifact as the authoritative schema.
  const schema = stored.artifact.assignment.outputSchema;
  const validation = validateContract(schema, stored.result.value);

  if (!validation.ok) {
    return {
      ok: false,
      errors: [
        "Parent-side contract revalidation failed.",
        "summary" in validation ? validation.summary : "Unknown validation failure.",
      ],
      contract: "invalid",
    };
  }

  return {
    ok: true,
    value: stored.result.value,
    errors: [],
    contract: "valid",
  };
}

// ── Attempt contract creation from resolved spec ────────────────────────────

export async function createAttemptContract(
  input: {
    readonly spec: ResolvedChildSpec;
    readonly assignment: {
      readonly task: string;
      readonly requirements: readonly string[];
      readonly outputSchema: Record<string, unknown>;
    };
    readonly identity: {
      readonly handleId: string;
      readonly parentHandleId?: string;
      readonly parentRunId?: RunId;
    };
    readonly cwd: string;
  },
): Promise<{
  readonly artifact: ContractArtifact;
  readonly capabilityToken: string;
  readonly phenixRunId: RunId;
}> {
  const phenixRunId = createRunId();

  const issued = issueContract({
    identity: {
      runId: phenixRunId,
      handleId: input.identity.handleId,
      ...(input.identity.parentHandleId
        ? { parentHandleId: input.identity.parentHandleId }
        : {}),
      ...(input.identity.parentRunId
        ? { parentRunId: input.identity.parentRunId }
        : {}),
      role: input.spec.role,
    },
    assignment: {
      task: input.assignment.task,
      requirements: input.assignment.requirements,
      outputSchema: input.assignment.outputSchema,
    },
    runtime: {
      agent: input.spec.agent,
      cwd: input.cwd,
      model: input.spec.model,
      thinking: input.spec.thinking,
      tools: input.spec.tools,
      skills: input.spec.skills,
      extensions: input.spec.extensions,
      delegation: {
        roles: input.spec.delegation.roles,
        availableRoles: input.spec.delegation.availableRoles,
        remainingDepth: input.spec.delegation.remainingDepth,
      },
      workflow: {
        instanceId: input.spec.workflow.instanceId,
        actorId: input.spec.workflow.actorId,
        ...(input.spec.workflow.parentActorId ? { parentActorId: input.spec.workflow.parentActorId } : {}),
        definitionId: input.spec.workflow.definitionId,
        definitionVersion: input.spec.workflow.definitionVersion,
        difficulty: input.spec.workflow.difficulty,
        initialState: input.spec.workflow.initialState,
        transitionCeiling: input.spec.workflow.transitionCeiling,
        capabilityArtifactHash: input.spec.workflow.capabilityArtifactHash,
      },
      timeoutMs: input.spec.timeoutMs,
      turnBudget: input.spec.turnBudget,
      toolBudget: input.spec.toolBudget,
    },
    verification: {
      commands: input.spec.verificationCommands,
      criticRequired: input.spec.criticRequired,
      maxRepairAttempts: input.spec.maxRepairAttempts,
    },
  });

  await contractsForCwd(input.cwd).create(issued.artifact);

  return {
    artifact: issued.artifact,
    capabilityToken: issued.capabilityToken,
    phenixRunId,
  };
}

// ── Environment helpers ─────────────────────────────────────────────────────

export function childContractEnv(
  contractId: ContractId,
  capabilityToken: string,
  phenixRunId: RunId,
  cwd: string,
): Record<string, string> {
  const storeRoot = path.join(
    findProjectRoot(cwd),
    ".phenix-agent-state",
    "contracts",
  );
  return {
    [PHENIX_CONTRACT_ID_ENV]: contractId,
    [PHENIX_CONTRACT_TOKEN_ENV]: capabilityToken,
    [PHENIX_RUN_ID_ENV]: phenixRunId,
    [PHENIX_CONTRACT_STORE_ENV]: storeRoot,
  };
}

// ── Repair task generator ───────────────────────────────────────────────────

export function repairTask(record: HandleRecord, evaluation: Evaluation): string {
  const numbered = evaluation.errors.map((error, index) => `${index + 1}. ${error}`).join("\n");
  return [
    record.assignment.task,
    "",
    "## Runtime repair request",
    "The previous handoff was rejected by authoritative runtime validation. Continue from the current workspace state and correct the work.",
    "",
    numbered,
    "",
    "The runtime will rerun the same structural contract, verification commands, and critic gate. Do not modify verification configuration or merely claim that checks passed.",
    "Finish by calling phenix_complete with a value matching the original schema.",
  ].join("\n");
}

export function expectedAcceptanceRank(policy: { readonly acceptance?: string }): number {
  return ACCEPTANCE_RANK[policy.acceptance ?? "verified"] ?? 0;
}

export { ACCEPTANCE_RANK };
