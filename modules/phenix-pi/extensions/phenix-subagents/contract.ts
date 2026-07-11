import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { JsonSchema } from "./contracts.ts";
import type { AgentRole, VerificationCommand } from "./policy.ts";
import type { ResolvedToolConfiguration } from "./tool-policy.ts";

declare const contractIdBrand: unique symbol;
declare const capabilityTokenBrand: unique symbol;
declare const runIdBrand: unique symbol;

export type ContractId = string & {
  readonly [contractIdBrand]: true;
};

export type CapabilityToken = string & {
  readonly [capabilityTokenBrand]: true;
};

export type RunId = string & {
  readonly [runIdBrand]: true;
};

// ── Contract identity (for bootstrap authentication) ────────────────────────

export interface ContractIdentity {
  readonly contractId: ContractId;
  readonly runId: RunId;
  readonly capabilityToken: CapabilityToken;
}

// ── Budget types ────────────────────────────────────────────────────────────

export interface TurnBudget {
  readonly maxTurns: number;
  readonly graceTurns: number;
}

export interface ToolBudget {
  readonly soft: number;
  readonly hard: number;
  readonly block: readonly string[];
}

// ── Contract artifact v2 ────────────────────────────────────────────────────

export interface ContractArtifactV2 {
  readonly version: 2;
  readonly id: ContractId;

  readonly identity: {
    readonly runId: RunId;
    readonly parentRunId?: RunId;
    readonly handleId: string;
    readonly parentHandleId?: string;
    readonly role: AgentRole;
  };

  readonly assignment: {
    readonly task: string;
    readonly requirements: readonly string[];
    readonly outputSchema: JsonSchema;
  };

  readonly runtime: {
    readonly agent: string;
    readonly cwd: string;
    readonly model?: string;
    readonly thinking: string;

    readonly tools: ResolvedToolConfiguration;
    readonly skills: readonly string[];
    readonly extensions: readonly string[];

    readonly allowedChildren: readonly AgentRole[];
    readonly maxDelegationDepth: number;

    readonly timeoutMs: number;
    readonly turnBudget: TurnBudget;
    readonly toolBudget: ToolBudget;
  };

  readonly verification: {
    readonly commands: readonly VerificationCommand[];
    readonly criticRequired: boolean;
    readonly maxRepairAttempts: number;
  };

  readonly capabilityTokenHash: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

// Keep the old name as an alias for backward compatibility during migration.
export type ContractArtifact = ContractArtifactV2;

// ── Result types (version 1, unchanged) ─────────────────────────────────────

export interface PendingContractResult {
  readonly version: 1;
  readonly state: "pending";
  readonly contractId: ContractId;
  readonly revision: number;
  readonly createdAt: string;
}

export interface SubmittedContractResult {
  readonly version: 1;
  readonly state: "submitted";
  readonly contractId: ContractId;
  readonly revision: number;
  readonly submittedAt: string;
  readonly value: unknown;
}

export interface CancelledContractResult {
  readonly version: 1;
  readonly state: "cancelled";
  readonly contractId: ContractId;
  readonly revision: number;
  readonly cancelledAt: string;
  readonly reason: string;
}

export type ContractResult =
  | PendingContractResult
  | SubmittedContractResult
  | CancelledContractResult;

export interface IssuedContract {
  readonly artifact: ContractArtifactV2;
  readonly capabilityToken: CapabilityToken;
}

// ── Authorization ───────────────────────────────────────────────────────────

export type ContractAuthorizationFailure =
  | "contract-id-mismatch"
  | "run-id-mismatch"
  | "invalid-capability"
  | "expired";

export type ContractAuthorizationResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly reason: ContractAuthorizationFailure;
    };

// ── Factory functions ───────────────────────────────────────────────────────

export function createContractId(): ContractId {
  return `phx_${randomUUID()}` as ContractId;
}

export function createRunId(): RunId {
  return `run_${randomUUID()}` as RunId;
}

export function createCapabilityToken(): CapabilityToken {
  return randomBytes(32).toString("base64url") as CapabilityToken;
}

export function hashCapabilityToken(
  token: CapabilityToken,
): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── Contract issuance (v2) ──────────────────────────────────────────────────

export type IssueContractInput = Pick<ContractArtifactV2,
  "identity" | "assignment" | "runtime" | "verification"
> & {
  readonly expiresAt?: string;
};

/**
 * Issue a new v2 contract artifact from a fully resolved specification.
 * No policy derivation, role configuration, or tool resolution happens here.
 */
export function issueContract(
  input: IssueContractInput,
): IssuedContract {
  const capabilityToken = createCapabilityToken();

  const artifact: ContractArtifactV2 = {
    version: 2,
    id: createContractId(),
    identity: {
      runId: input.identity.runId,
      ...(input.identity.parentRunId ? { parentRunId: input.identity.parentRunId } : {}),
      handleId: input.identity.handleId,
      ...(input.identity.parentHandleId ? { parentHandleId: input.identity.parentHandleId } : {}),
      role: input.identity.role,
    },
    assignment: {
      task: input.assignment.task,
      requirements: [...input.assignment.requirements],
      outputSchema: input.assignment.outputSchema,
    },
    runtime: {
      agent: input.runtime.agent,
      cwd: input.runtime.cwd,
      ...(input.runtime.model ? { model: input.runtime.model } : {}),
      thinking: input.runtime.thinking,
      tools: input.runtime.tools,
      skills: [...input.runtime.skills],
      extensions: [...input.runtime.extensions],
      allowedChildren: [...input.runtime.allowedChildren],
      maxDelegationDepth: input.runtime.maxDelegationDepth,
      timeoutMs: input.runtime.timeoutMs,
      turnBudget: { ...input.runtime.turnBudget },
      toolBudget: { ...input.runtime.toolBudget },
    },
    verification: {
      commands: [...input.verification.commands],
      criticRequired: input.verification.criticRequired,
      maxRepairAttempts: input.verification.maxRepairAttempts,
    },
    capabilityTokenHash: hashCapabilityToken(capabilityToken),
    createdAt: new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };

  return { artifact, capabilityToken };
}

// ── Token verification ──────────────────────────────────────────────────────

function equalHexHashes(
  left: string,
  right: string,
): boolean {
  try {
    const leftBytes = Buffer.from(left, "hex");
    const rightBytes = Buffer.from(right, "hex");

    if (leftBytes.length !== rightBytes.length) {
      return false;
    }

    return timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

// ── Contract authorization ──────────────────────────────────────────────────

/**
 * Authorize a contract identity against an artifact.
 * Role is no longer checked here — it's part of the artifact identity.
 */
export function authorizeContract(
  artifact: ContractArtifactV2,
  identity: ContractIdentity,
  now = new Date(),
): ContractAuthorizationResult {
  if (identity.contractId !== artifact.id) {
    return {
      ok: false,
      reason: "contract-id-mismatch",
    };
  }

  if (identity.runId !== artifact.identity.runId) {
    return {
      ok: false,
      reason: "run-id-mismatch",
    };
  }

  const candidateHash = hashCapabilityToken(identity.capabilityToken);

  if (
    !equalHexHashes(
      candidateHash,
      artifact.capabilityTokenHash,
    )
  ) {
    return {
      ok: false,
      reason: "invalid-capability",
    };
  }

  if (
    artifact.expiresAt &&
    now.getTime() >= new Date(artifact.expiresAt).getTime()
  ) {
    return {
      ok: false,
      reason: "expired",
    };
  }

  return { ok: true };
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

export function parseContractId(
  value: unknown,
): ContractId | undefined {
  if (
    typeof value !== "string" ||
    !/^phx_[0-9a-f-]{36}$/i.test(value)
  ) {
    return undefined;
  }

  return value as ContractId;
}

export function parseRunId(
  value: unknown,
): RunId | undefined {
  if (
    typeof value !== "string" ||
    !/^run_[0-9a-f-]{36}$/i.test(value)
  ) {
    return undefined;
  }

  return value as RunId;
}

export function parseCapabilityToken(
  value: unknown,
): CapabilityToken | undefined {
  if (
    typeof value !== "string" ||
    value.length < 32
  ) {
    return undefined;
  }

  return value as CapabilityToken;
}
