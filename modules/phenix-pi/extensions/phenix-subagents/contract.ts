import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { PHENIX_API_VERSION } from "../phenix-kernel/api-version.ts";

import type { JsonSchema } from "../phenix-contracts/definitions.ts";
import type { Difficulty } from "../phenix-routing/types.ts";
import type { TransitionAuthority } from "../phenix-workflow/transition-authority.ts";
import type {
  DefaultWorkflowDefinitionId,
  WorkflowStateId,
} from "../phenix-workflow/workflow-types.ts";
import type {
  AgentKind,
  AgentRole,
  ToolBudget,
  TurnBudget,
  VerificationCommand,
} from "./agent-types.ts";
import type { ResolvedDelegateRoleConfiguration } from "./delegation-policy.ts";
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


// ── Contract artifact and execution manifest ───────────────────────────────

export interface ContractRuntimeIdentity {
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly handleId: string;
  readonly parentHandleId?: string;
  readonly role: AgentRole;
}

export interface ContractAssignment {
  readonly task: string;
  readonly requirements: readonly string[];
  readonly outputSchema: JsonSchema;
}

/**
 * Runtime execution manifest installed into a child session.
 *
 * This is deliberately distinct from static contract definitions in
 * phenix-contracts and from the persisted ContractArtifact envelope.
 */
export interface ContractExecutionManifest {
  readonly agent: `phenix.${AgentKind}` | "phenix.base";

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

    readonly definitionId: DefaultWorkflowDefinitionId;
    readonly definitionVersion: typeof PHENIX_API_VERSION;

    readonly difficulty: Difficulty;

    readonly initialState: WorkflowStateId;

    readonly transitionAuthority: TransitionAuthority;

    readonly capabilityArtifactHash: string;
  };

  readonly timeoutMs: number;
  readonly turnBudget: TurnBudget;
  readonly toolBudget: ToolBudget;
}

export interface ContractRuntimeInstance {
  readonly identity: ContractRuntimeIdentity;
  readonly assignment: ContractAssignment;
  readonly manifest: ContractExecutionManifest;
}

export interface ContractArtifact {
  readonly schemaVersion: typeof PHENIX_API_VERSION;
  readonly id: ContractId;

  readonly identity: ContractRuntimeIdentity;

  readonly assignment: ContractAssignment;

  readonly runtime: ContractExecutionManifest;

  readonly verification: {
    readonly commands: readonly VerificationCommand[];
    readonly criticRequired: boolean;
    readonly maxRepairAttempts: number;
  };

  readonly capabilityTokenHash: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}


// ── Result types ────────────────────────────────────────────────────────────

export interface PendingContractResult {
  readonly schemaVersion: typeof PHENIX_API_VERSION;
  readonly state: "pending";
  readonly contractId: ContractId;
  readonly revision: number;
  readonly createdAt: string;
  readonly history: readonly ContractSubmissionRecord[];
}

export interface SubmittedContractResult {
  readonly schemaVersion: typeof PHENIX_API_VERSION;
  readonly state: "submitted";
  readonly contractId: ContractId;
  readonly revision: number;
  readonly submittedAt: string;
  readonly value: unknown;
  readonly history: readonly ContractSubmissionRecord[];
}

export interface AcceptedContractResult {
  readonly schemaVersion: typeof PHENIX_API_VERSION;
  readonly state: "accepted";
  readonly contractId: ContractId;
  readonly revision: number;
  readonly acceptedAt: string;
  readonly value: unknown;
  readonly history: readonly ContractSubmissionRecord[];
}

export interface CancelledContractResult {
  readonly schemaVersion: typeof PHENIX_API_VERSION;
  readonly state: "cancelled";
  readonly contractId: ContractId;
  readonly revision: number;
  readonly cancelledAt: string;
  readonly reason: string;
  readonly history: readonly ContractSubmissionRecord[];
}

export type ContractResult =
  | PendingContractResult
  | SubmittedContractResult
  | AcceptedContractResult
  | CancelledContractResult;

export interface ContractSubmissionRecord {
  readonly revision: number;
  readonly submittedAt: string;
  readonly value: unknown;
  readonly disposition?:
    | "accepted"
    | "runtime-rejected"
    | "verification-rejected"
    | "critic-rejected";
  readonly issues?: readonly {
    readonly path: readonly (string | number)[];
    readonly message: string;
    readonly code?: string;
  }[];
}

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

export function hashCapabilityToken(token: CapabilityToken): string {
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
export function issueContract(input: IssueContractInput): IssuedContract {
  const capabilityToken = createCapabilityToken();

  const artifact: ContractArtifact = {
    schemaVersion: PHENIX_API_VERSION,
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
          presetRevision: PHENIX_API_VERSION,
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
        ...(input.runtime.workflow.parentActorId
          ? { parentActorId: input.runtime.workflow.parentActorId }
          : {}),
        definitionId: input.runtime.workflow.definitionId,
        definitionVersion: input.runtime.workflow.definitionVersion,
        difficulty: input.runtime.workflow.difficulty,
        initialState: input.runtime.workflow.initialState,
        transitionAuthority:
          input.runtime.workflow.transitionAuthority.kind === "unrestricted"
            ? { kind: "unrestricted" as const }
            : {
                kind: "restricted" as const,
                allowed: [...input.runtime.workflow.transitionAuthority.allowed],
              },
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

function equalHexHashes(left: string, right: string): boolean {
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

  if (!equalHexHashes(candidateHash, artifact.capabilityTokenHash)) {
    return {
      ok: false,
      reason: "invalid-capability",
    };
  }

  if (artifact.expiresAt && now.getTime() >= new Date(artifact.expiresAt).getTime()) {
    return {
      ok: false,
      reason: "expired",
    };
  }

  return { ok: true };
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

export function parseContractId(value: unknown): ContractId | undefined {
  if (typeof value !== "string" || !/^phx_[0-9a-f-]{36}$/i.test(value)) {
    return undefined;
  }

  return value as ContractId;
}

export function parseRunId(value: unknown): RunId | undefined {
  if (typeof value !== "string" || !/^run_[0-9a-f-]{36}$/i.test(value)) {
    return undefined;
  }

  return value as RunId;
}

export function parseCapabilityToken(value: unknown): CapabilityToken | undefined {
  if (typeof value !== "string" || value.length < 32) {
    return undefined;
  }

  return value as CapabilityToken;
}
