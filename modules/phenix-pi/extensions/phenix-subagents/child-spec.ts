import type { Difficulty } from "../phenix-routing/types.ts";
import type { AgentCapabilityArtifact } from "../phenix-workflow/agent-capabilities.ts";
import { isSpawnableAgent } from "../phenix-workflow/agent-capabilities.ts";
import type { TransitionAuthority } from "../phenix-workflow/transition-authority.ts";
import type {
  DefaultWorkflowDefinitionId,
  WorkflowStateId,
} from "../phenix-workflow/workflow-types.ts";
import type {
  AgentKind,
  AgentRole,
  ModelTier,
  ProfileHint,
  TaskProfile,
  ThinkingLevel,
  ToolBudget,
  TurnBudget,
  VerificationCommand,
} from "./agent-types.ts";
import type { ContractArtifact } from "./contract.ts";
import {
  type DelegateRolePatchInput,
  type ResolvedDelegateRoleConfiguration,
  resolveDelegateRoleConfiguration,
} from "./delegation-policy.ts";
import { type RuntimePolicyConfig, resolveExecutionPolicy } from "./policy.ts";
import {
  type ResolvedToolConfiguration,
  resolveToolConfiguration,
  type ToolPatch,
} from "./tool-policy.ts";

// ── Resolved child specification ────────────────────────────────────────────

export interface ResolvedChildSpec {
  readonly role: AgentRole;
  readonly agent: `phenix.${AgentKind}` | "phenix.base";

  readonly profile: TaskProfile;
  readonly tier: ModelTier;

  readonly model?: string;
  readonly thinking: ThinkingLevel;
  readonly cwd: string;

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

    readonly difficulty: Difficulty;

    readonly initialState: WorkflowStateId;

    readonly transitionAuthority: TransitionAuthority;

    readonly capabilityArtifactHash: string;
  };

  readonly timeoutMs: number;
  readonly turnBudget: TurnBudget;
  readonly toolBudget: ToolBudget;

  readonly verificationCommands: readonly VerificationCommand[];
  readonly criticRequired: boolean;
  readonly maxRepairAttempts: number;
}

// ── Creator context ─────────────────────────────────────────────────────────

export type ContractCreatorContext =
  | {
      readonly kind: "root";
      readonly maximumDelegationDepth: number;
    }
  | {
      readonly kind: "child";
      readonly contract: ContractArtifact;
    }
  | {
      readonly kind: "runtime-internal";
      readonly maximumDelegationDepth: number;
    };

// ── Workflow child input ────────────────────────────────────────────────────

export interface ResolvedWorkflowChildInput {
  readonly instanceId: string;
  readonly actorId: string;
  readonly parentActorId?: string;
  readonly definitionId: DefaultWorkflowDefinitionId;
  readonly difficulty: Difficulty;
  readonly initialState: WorkflowStateId;
  readonly transitionAuthority: TransitionAuthority;
  readonly capabilityArtifactHash: string;
}

// ── Input types ─────────────────────────────────────────────────────────────

export interface ChildSpecInput {
  readonly role: AgentRole;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly outputSchema: Record<string, unknown>;
  readonly profileHint?: ProfileHint;
  readonly tools?: {
    readonly additional?: readonly string[];
    readonly removed?: readonly string[];
  } | null;
  readonly delegateRoles?: DelegateRolePatchInput | null;
  readonly skills?: readonly string[];
  readonly extensions?: readonly string[];
  readonly cwd: string;
  readonly creator: ContractCreatorContext;
  readonly config?: RuntimePolicyConfig;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly capabilityArtifact: AgentCapabilityArtifact;
  readonly workflow: ResolvedWorkflowChildInput;
  readonly routingContext?: {
    readonly modelSet?: string;
    readonly difficulty?: string;
    readonly capability?: string;
    readonly candidatePool?: string;
    readonly candidateIndex?: number;
  };
}

// ── Resolution ──────────────────────────────────────────────────────────────

export function resolveChildSpec(input: ChildSpecInput): ResolvedChildSpec {
  // 1. Resolve execution policy (profile, tier, thinking, budgets, critic).
  const policy = resolveExecutionPolicy({
    role: input.role,
    task: input.task,
    requirements: input.requirements,
    profileHint: input.profileHint,
    cwd: input.cwd,
    config: input.config,
  });

  // 2. Determine inherited patches from creator context.
  let inheritedToolPatch: ToolPatch | undefined;
  let delegableTools: readonly string[] | undefined;

  let inheritedRolePatch: DelegateRolePatchInput | undefined;
  let delegableRoleCeiling: readonly AgentRole[] | undefined;
  let remainingDepth: number;

  if (input.creator.kind === "child") {
    inheritedToolPatch = input.creator.contract.runtime.tools.source.patch;
    delegableTools = input.creator.contract.runtime.tools.effective;

    inheritedRolePatch = input.creator.contract.runtime.delegation.roles.source.patch;
    delegableRoleCeiling = input.creator.contract.runtime.delegation.roles.effective;

    remainingDepth = Math.max(0, input.creator.contract.runtime.delegation.remainingDepth - 1);
  } else {
    // root or runtime-internal: no inherited patches, unrestricted ceilings.
    inheritedToolPatch = undefined;
    delegableTools = undefined;
    inheritedRolePatch = undefined;
    delegableRoleCeiling = undefined;
    remainingDepth = input.creator.maximumDelegationDepth;
  }

  // 3. Resolve tool configuration.
  const tools = resolveToolConfiguration({
    role: input.role,
    requested: input.tools,
    inheritedPatch: inheritedToolPatch,
    delegableTools,
  });

  // 4. Resolve delegate role configuration.
  const roles = resolveDelegateRoleConfiguration({
    role: input.role,
    requested: input.delegateRoles ?? null,
    inheritedPatch: inheritedRolePatch
      ? {
          additional: [...(inheritedRolePatch.additional ?? [])],
          removed: [...(inheritedRolePatch.removed ?? [])],
        }
      : undefined,
    delegableRoles: delegableRoleCeiling,
  });

  // 5. Filter available roles against capability artifact.
  const availableRoles = roles.effective.filter((role) =>
    isSpawnableAgent(input.capabilityArtifact, role),
  );

  return {
    role: input.role,
    agent: policy.agent,
    profile: policy.profile,
    tier: policy.tier,
    model: input.model ?? policy.model,
    thinking: input.thinking ?? policy.thinking,
    cwd: input.cwd,
    tools,
    skills: input.skills ?? [],
    extensions: input.extensions ?? [],
    delegation: {
      roles,
      availableRoles,
      remainingDepth,
    },
    workflow: {
      instanceId: input.workflow.instanceId,
      actorId: input.workflow.actorId,
      parentActorId: input.workflow.parentActorId,
      definitionId: input.workflow.definitionId,
      difficulty: input.workflow.difficulty,
      initialState: input.workflow.initialState,
      transitionAuthority:
        input.workflow.transitionAuthority.kind === "unrestricted"
          ? { kind: "unrestricted" as const }
          : {
              kind: "restricted" as const,
              allowed: [...input.workflow.transitionAuthority.allowed],
            },
      capabilityArtifactHash: input.workflow.capabilityArtifactHash,
    },
    timeoutMs: policy.timeoutMs,
    turnBudget: policy.turnBudget,
    toolBudget: policy.toolBudget,
    verificationCommands: policy.verificationCommands,
    criticRequired: policy.criticRequired,
    maxRepairAttempts: policy.maxRepairAttempts,
  };
}
