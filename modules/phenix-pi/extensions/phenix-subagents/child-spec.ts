import type {
  AgentRole,
  AgentKind,
  ModelTier,
  TaskProfile,
  ThinkingLevel,
  TurnBudget,
  ToolBudget,
  VerificationCommand,
  ProfileHint,
} from "./agent-types.ts";
import {
  resolveExecutionPolicy,
  type RuntimePolicyConfig,
} from "./policy.ts";
import {
  resolveToolConfiguration,
  type ResolvedToolConfiguration,
  type ToolPatch,
} from "./tool-policy.ts";
import type { ContractArtifact } from "./contract.ts";

// ── Resolved child specification ────────────────────────────────────────────

export interface ResolvedChildSpec {
  readonly role: AgentRole;
  readonly agent:
    | `phenix.${AgentKind}`
    | "phenix.base";

  readonly profile: TaskProfile;
  readonly tier: ModelTier;

  readonly model?: string;
  readonly thinking: ThinkingLevel;
  readonly cwd: string;

  readonly tools:
    ResolvedToolConfiguration;

  readonly skills: readonly string[];
  readonly extensions: readonly string[];

  readonly allowedChildren:
    readonly AgentKind[];

  readonly remainingDelegationDepth:
    number;

  readonly timeoutMs: number;
  readonly turnBudget: TurnBudget;
  readonly toolBudget: ToolBudget;

  readonly verificationCommands:
    readonly VerificationCommand[];

  readonly criticRequired: boolean;
  readonly maxRepairAttempts: number;
}

// ── Creator context ─────────────────────────────────────────────────────────

export type ContractCreatorContext =
  | {
      readonly kind: "root";
      readonly maximumDelegationDepth:
        number;
    }
  | {
      readonly kind: "child";
      readonly contract: ContractArtifact;
    }
  | {
      readonly kind: "runtime-internal";
      readonly maximumDelegationDepth:
        number;
    };

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
  readonly skills?: readonly string[];
  readonly extensions?: readonly string[];
  readonly cwd: string;
  readonly creator: ContractCreatorContext;
  readonly config?: RuntimePolicyConfig;
  readonly model?: string;
  readonly routingContext?: {
    readonly modelSet?: string;
    readonly difficulty?: string;
    readonly capability?: string;
    readonly candidatePool?: string;
    readonly candidateIndex?: number;
  };
}

// ── Resolution ──────────────────────────────────────────────────────────────

export function resolveChildSpec(
  input: ChildSpecInput,
): ResolvedChildSpec {
  // 1. Resolve execution policy (profile, tier, thinking, budgets, children, critic).
  const policy = resolveExecutionPolicy({
    role: input.role,
    task: input.task,
    requirements: input.requirements,
    profileHint: input.profileHint,
    cwd: input.cwd,
    config: input.config,
  });

  // 2. Determine inherited patch from creator context.
  let inheritedPatch: ToolPatch | undefined;
  let delegableTools: readonly string[] | undefined;

  if (input.creator.kind === "child") {
    inheritedPatch = input.creator.contract.runtime.tools.source.patch;
    delegableTools = input.creator.contract.runtime.tools.effective;
  } else {
    // root or runtime-internal: no inherited patch, unrestricted ceiling.
    inheritedPatch = undefined;
    delegableTools = undefined;
  }

  // 3. Resolve tool configuration.
  const tools = resolveToolConfiguration({
    role: input.role,
    requested: input.tools,
    inheritedPatch,
    delegableTools,
  });

  // 4. Calculate remaining delegation depth.
  const remainingDelegationDepth =
    input.creator.kind === "child"
      ? Math.max(
          0,
          input.creator.contract.runtime.remainingDelegationDepth - 1,
        )
      : input.creator.maximumDelegationDepth;

  return {
    role: input.role,
    agent: policy.agent,
    profile: policy.profile,
    tier: policy.tier,
    model: input.model ?? policy.model,
    thinking: policy.thinking,
    cwd: input.cwd,
    tools,
    skills: input.skills ?? [],
    extensions: input.extensions ?? [],
    allowedChildren: policy.allowedChildren,
    remainingDelegationDepth,
    timeoutMs: policy.timeoutMs,
    turnBudget: policy.turnBudget,
    toolBudget: policy.toolBudget,
    verificationCommands: policy.verificationCommands,
    criticRequired: policy.criticRequired,
    maxRepairAttempts: policy.maxRepairAttempts,
  };
}
