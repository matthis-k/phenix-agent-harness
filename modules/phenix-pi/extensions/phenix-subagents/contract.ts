import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { JsonSchema } from "./contracts.ts";
import type { AgentKind, AgentRole, TurnBudget, ToolBudget, VerificationCommand } from "./agent-types.ts";
import type { ResolvedToolConfiguration } from "./tool-policy.ts";
import type { ResolvedDelegateRoleConfiguration } from "./delegation-policy.ts";
import type { WorkflowDefinitionId, WorkflowStateId } from "../phenix-workflow/workflow-types.ts";
import type { TransitionAuthority } from "../phenix-workflow/transition-authority.ts";
import type { Difficulty } from "../phenix-routing/types.ts";

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

export const CONTRACT_SCHEMA_VERSION = 1 as const;

// ── Contract artifact ───────────────────────────────────────────────────────

export interface ContractArtifact {
  readonly schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
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
    readonly agent:
      | `phenix.${AgentKind}`
      | "phenix.base";

    readonly cwd: string;
    readonly model?: string;
    readonly thinking: string;

    readonly tools: ResolvedToolConfiguration;

    readonly skills: readonly string[];
    readonly extensions: readonly string[];

    readonly delegation: {
      readonly roles: ResolvedDelegateRoleConfiguration;

      readonly availableRoles: readonly AgentRole[];

      readonly remainingDepth: number;
    };

    readonly workflow: {
      readonly instanceId: string;
      readonly actorId: string;
      readonly parentActorId?: string;

      readonly definitionId: WorkflowDefinitionId;
      readonly definitionVersion: 1;

      readonly difficulty: Difficulty;

      readonly initialState: WorkflowStateId;

      readonly transitionAuthority: TransitionAuthority;

      readonly capabilityArtifactHash: string;
    };

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

export const CONTRACT_RESULT_SCHEMA_VERSION = 1 as const;

// ── Result types ────────────────────────────────────────────────────────────

export interface PendingContractResult {
  readonly schemaVersion: typeof CONTRACT_RESULT_SCHEMA_VERSION;
  readonly state: "pending";
  readonly contractId: ContractId;
  readonly revision: number;
  readonly createdAt: string;
}

export interface SubmittedContractResult {
  readonly schemaVersion: typeof CONTRACT_RESULT_SCHEMA_VERSION;
  readonly state: "submitted";
  readonly contractId: ContractId;
  readonly revision: number;
  readonly submittedAt: string;
  readonly value: unknown;
}

export interface CancelledContractResult {
  readonly schemaVersion: typeof CONTRACT_RESULT_SCHEMA_VERSION;
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

// ── Contract issuance ──────────────────────────────────────────────────────

export type IssueContractInput = {
  readonly identity: ContractArtifact["identity"];
  readonly assignment: ContractArtifact["assignment"];
  readonly runtime: ContractArtifact["runtime"];
  readonly verification: ContractArtifact["verification"];
  readonly expiresAt?: string;
};

/**
 * Issue a new contract artifact from a fully resolved specification.
 * No policy derivation, role configuration, or tool resolution happens here.
 */
export function issueContract(
  input: IssueContractInput,
): IssuedContract {
  const capabilityToken = createCapabilityToken();

  const artifact: ContractArtifact = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
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
      tools: {
        ...input.runtime.tools,
        source: {
          inherited: input.runtime.tools.source.inherited,
          patch: {
            additional: [...input.runtime.tools.source.patch.additional],
            removed: [...input.runtime.tools.source.patch.removed],
          },
        },
        effective: [...input.runtime.tools.effective],
      },
      skills: [...input.runtime.skills],
      extensions: [...input.runtime.extensions],
      delegation: {
        roles: {
          presetRevision: input.runtime.delegation.roles.presetRevision,
          role: input.runtime.delegation.roles.role,
          source: {
            inherited: input.runtime.delegation.roles.source.inherited,
            patch: {
              additional: [...input.runtime.delegation.roles.source.patch.additional],
              removed: [...input.runtime.delegation.roles.source.patch.removed],
            },
          },
          effective: [...input.runtime.delegation.roles.effective],
        },
        availableRoles: [...input.runtime.delegation.availableRoles],
        remainingDepth: input.runtime.delegation.remainingDepth,
      },
      workflow: {
        instanceId: input.runtime.workflow.instanceId,
        actorId: input.runtime.workflow.actorId,
        ...(input.runtime.workflow.parentActorId ? { parentActorId: input.runtime.workflow.parentActorId } : {}),
        definitionId: input.runtime.workflow.definitionId,
        definitionVersion: input.runtime.workflow.definitionVersion,
        difficulty: input.runtime.workflow.difficulty,
        initialState: input.runtime.workflow.initialState,
        transitionAuthority: input.runtime.workflow.transitionAuthority.kind === "unrestricted"
          ? { kind: "unrestricted" as const }
          : { kind: "restricted" as const, allowed: [...input.runtime.workflow.transitionAuthority.allowed] },
        capabilityArtifactHash: input.runtime.workflow.capabilityArtifactHash,
      },
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
 */
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
