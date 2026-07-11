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
  type ContractArtifactV2,
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
  AgentRole,
} from "./policy.ts";

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

// ── Attempt creation ────────────────────────────────────────────────────────

export async function createAttemptContract(
  record: HandleRecord,
  task: string,
  cwd: string,
): Promise<{
  readonly artifact: ContractArtifactV2;
  readonly capabilityToken: string;
  readonly phenixRunId: RunId;
}> {
  const phenixRunId = createRunId();

  const handleId = `${record.id}-attempt-${record.attempts.length + 1}`;
  const parentHandleId = record.id;

  const issued = issueContract({
    identity: {
      runId: phenixRunId,
      handleId,
      parentHandleId,
      role: record.role,
    },
    assignment: {
      task,
      requirements: record.requirements,
      outputSchema: record.outputSchema,
    },
    runtime: {
      agent: record.policy.agent,
      cwd,
      model: record.policy.model,
      thinking: record.policy.thinking,
      tools: record.resolvedTools,
      skills: [],
      extensions: [],
      allowedChildren: record.policy.allowedChildren.map((r: import("./policy.ts").AgentKind) => r as AgentRole),
      maxDelegationDepth: 2, // Default, could be derived from policy.
      timeoutMs: record.policy.timeoutMs,
      turnBudget: record.policy.turnBudget,
      toolBudget: record.policy.toolBudget,
    },
    verification: {
      commands: record.policy.verificationCommands,
      criticRequired: record.policy.criticRequired,
      maxRepairAttempts: record.policy.maxRepairAttempts,
    },
  });

  await contractsForCwd(cwd).create(issued.artifact);

  return {
    artifact: issued.artifact,
    capabilityToken: issued.capabilityToken,
    phenixRunId,
  };
}

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

// ── Repair task generation ──────────────────────────────────────────────────

export function repairTask(record: HandleRecord, evaluation: Evaluation): string {
  const numbered = evaluation.errors.map((error, index) => `${index + 1}. ${error}`).join("\n");
  return [
    record.task,
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
