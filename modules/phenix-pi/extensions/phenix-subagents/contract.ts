import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { JsonSchema } from "./contracts.ts";
import type { AgentKind } from "./policy.ts";

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

export interface ContractIdentity {
  readonly contractId: ContractId;
  readonly runId: RunId;
  readonly role: AgentKind;
  readonly capabilityToken: CapabilityToken;
}

export interface ContractArtifact {
  readonly version: 1;
  readonly id: ContractId;
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly role: AgentKind;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly outputSchema: JsonSchema;
  readonly capabilityTokenHash: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

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
  readonly artifact: ContractArtifact;
  readonly capabilityToken: CapabilityToken;
}

export type ContractAuthorizationFailure =
  | "contract-id-mismatch"
  | "run-id-mismatch"
  | "role-mismatch"
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

export function issueContract(input: {
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly role: AgentKind;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly outputSchema: JsonSchema;
  readonly expiresAt?: string;
}): IssuedContract {
  const capabilityToken = createCapabilityToken();

  return {
    artifact: {
      version: 1,
      id: createContractId(),
      runId: input.runId,
      ...(input.parentRunId
        ? {
            parentRunId: input.parentRunId,
          }
        : {}),
      role: input.role,
      task: input.task,
      requirements: [...input.requirements],
      outputSchema: input.outputSchema,
      capabilityTokenHash:
        hashCapabilityToken(capabilityToken),
      createdAt: new Date().toISOString(),
      ...(input.expiresAt
        ? {
            expiresAt: input.expiresAt,
          }
        : {}),
    },
    capabilityToken,
  };
}

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

export function authorizeContract(
  artifact: ContractArtifact,
  identity: ContractIdentity,
  now = new Date(),
): ContractAuthorizationResult {
  if (identity.contractId !== artifact.id) {
    return {
      ok: false,
      reason: "contract-id-mismatch",
    };
  }

  if (identity.runId !== artifact.runId) {
    return {
      ok: false,
      reason: "run-id-mismatch",
    };
  }

  if (identity.role !== artifact.role) {
    return {
      ok: false,
      reason: "role-mismatch",
    };
  }

  const candidateHash =
    hashCapabilityToken(identity.capabilityToken);

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

  return {
    ok: true,
  };
}

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
