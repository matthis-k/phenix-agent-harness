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
    readonly definitionVersion: 1;

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
  readonly definitionVersion: 1;
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
    config: input.config,
  });

  // 2. Resolve tools from role preset + caller patch.
  const toolPatch: ToolPatch | undefined = input.tools
    ? {
        additional: input.tools.additional ?? [],
        removed: input.tools.removed ?? [],
      }
    : undefined;
  const tools = resolveToolConfiguration(input.role, toolPatch);

  // 3. Resolve delegation roles from role preset + caller patch.
  const delegationRoles = resolveDelegateRoleConfiguration(input.role, input.delegateRoles);

  // 4. Restrict effective delegation roles to clients that are both present in
  // the immutable capability artifact and authorized by this role's preset.
  const availableRoles = delegationRoles.effective.filter((role) =>
    isSpawnableAgent(input.capabilityArtifact, role),
  );

  // 5. Calculate remaining depth from creator context.
  const remainingDepth =
    input.creator.kind === "child"
      ? Math.max(0, input.creator.contract.runtime.delegation.remainingDepth - 1)
      : input.creator.maximumDelegationDepth;

  return {
    role: input.role,
    agent: input.role === null ? "phenix.base" : `phenix.${input.role}`,
    profile: policy.profile,
    tier: policy.tier,
    ...(input.model ? { model: input.model } : {}),
    thinking: input.thinking ?? policy.thinking,
    cwd: input.cwd,
    tools,
    skills: input.skills ?? [],
    extensions: input.extensions ?? [],
    delegation: {
      roles: delegationRoles,
      availableRoles,
      remainingDepth,
    },
    workflow: input.workflow,
    timeoutMs: policy.timeoutMs,
    turnBudget: policy.turnBudget,
    toolBudget: policy.toolBudget,
    verificationCommands: policy.verificationCommands,
    criticRequired: policy.criticRequired,
    maxRepairAttempts: policy.maxRepairAttempts,
  };
}
