import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveTaskProfileFromText } from "@matthis-k/phenix-kernel/task.ts";
import { mergeObjects, readJson } from "../shared.ts";
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
import { rolePreset } from "./role-presets.ts";

export type {
  AgentKind,
  AgentRole,
  ModelTier,
  ProfileHint,
  TaskProfile,
  ThinkingLevel,
  ToolBudget,
  TurnBudget,
  VerificationCommand,
};

// ── Configuration types ─────────────────────────────────────────────────────

interface VerificationConfig {
  readonly maxRepairAttempts?: number;
  readonly timeoutMs?: number;
  readonly extraCommands?: readonly VerificationCommand[];
  readonly roleCommands?: Partial<Record<AgentKind, readonly VerificationCommand[]>>;
}

interface ToolBudgetConfig {
  /** Advisory warning threshold. Defaults to the model tier's convergence hint. */
  readonly soft?: number;
  /** Explicit hard cap. Omitted by default, including for repository QA. */
  readonly hard?: number;
}

interface ExecutionConfig {
  /** Explicit hard turn limit. Omitted by default for open-ended execution. */
  readonly turnBudget?: TurnBudget;
  /** Tool-call policy. Hard limits are opt-in; soft limits remain advisory. */
  readonly toolBudget?: ToolBudgetConfig;
}

export interface RuntimePolicyConfig {
  readonly execution?: ExecutionConfig;
  readonly verification?: VerificationConfig;
}

// ── Resolved execution policy ────────────────────────────────────────────────

export interface ResolvedExecutionPolicy {
  readonly role: AgentRole;
  readonly agent: `phenix.${AgentKind}` | "phenix.base";

  readonly profile: TaskProfile;
  readonly tier: ModelTier;

  readonly model?: string;
  readonly thinking: ThinkingLevel;

  readonly timeoutMs: number;
  readonly turnBudget: TurnBudget;
  readonly toolBudget: ToolBudget;

  readonly verificationCommands: readonly VerificationCommand[];

  readonly criticRequired: boolean;
  readonly maxRepairAttempts: number;
  readonly allowedChildren: readonly AgentKind[];

  // Routing fields (added by phenix-routing integration).
  readonly modelSet?: string;
  readonly difficulty?: string;
  readonly capability?: string;
  readonly candidatePool?: string;
  readonly candidateIndex?: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RuntimePolicyConfig = {
  verification: {
    maxRepairAttempts: 1,
    timeoutMs: 180_000,
    extraCommands: [],
    roleCommands: {},
  },
};

// ── Config loading ──────────────────────────────────────────────────────────

export function loadPolicyConfig(): RuntimePolicyConfig {
  const bundledPath = fileURLToPath(new URL("../../config/subagents.json", import.meta.url));
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const userPath = path.join(agentDir, "phenix-subagents.json");
  const bundled = mergeObjects(DEFAULT_CONFIG as Record<string, unknown>, readJson(bundledPath));
  return mergeObjects(bundled, readJson(userPath)) as RuntimePolicyConfig;
}

// ── Profile derivation ──────────────────────────────────────────────────────

export function deriveTaskProfile(
  role: AgentRole,
  task: string,
  requirements: readonly string[],
  hint: ProfileHint = {},
): TaskProfile {
  const preset = rolePreset(role);
  return deriveTaskProfileFromText(task, requirements, hint, preset.profileMinimums);
}

// ── Tier calculation ────────────────────────────────────────────────────────

export function tierForProfile(profile: TaskProfile): ModelTier {
  const peak = Math.max(...Object.values(profile));
  if (profile.consequence >= 4 || peak >= 4) return "critical";
  if (
    profile.complexity >= 3 ||
    profile.uncertainty >= 3 ||
    profile.consequence >= 3 ||
    profile.coupling >= 3
  ) {
    return "high";
  }
  if (peak >= 2) return "standard";
  return "low";
}

// ── Shell quoting ───────────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// ── Verification commands ──────────────────────────────────────────────────

function verificationCommands(
  role: AgentRole,
  cwd: string,
  config: RuntimePolicyConfig,
): readonly VerificationCommand[] {
  const scriptPath = fileURLToPath(new URL("../../runtime/verify.mjs", import.meta.url));
  const commands: VerificationCommand[] = [];

  // Only implementer and tester roles get the default runtime verification.
  if (role === "implementer" || role === "tester") {
    commands.push({
      id: "phenix-runtime-verification",
      command: `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} --cwd ${shellQuote(cwd)}`,
      cwd,
      timeoutMs: config.verification?.timeoutMs ?? 180_000,
    });
  }

  // Null role gets no role-specific verification commands.
  if (role === null) return commands;

  for (const command of config.verification?.extraCommands ?? []) commands.push(command);
  for (const command of config.verification?.roleCommands?.[role] ?? []) commands.push(command);

  return commands;
}

// ── Budget tables ───────────────────────────────────────────────────────────

const TIER_BUDGETS: Record<ModelTier, { advisoryTools: number; timeout: number }> = {
  low: { advisoryTools: 30, timeout: 10 * 60_000 },
  standard: { advisoryTools: 60, timeout: 20 * 60_000 },
  high: { advisoryTools: 105, timeout: 35 * 60_000 },
  critical: { advisoryTools: 165, timeout: 60 * 60_000 },
};

const BLOCKED_AFTER_HARD_LIMIT: readonly string[] = [
  "read",
  "grep",
  "search",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "lsp",
  "mcp",
  "web_search",
  "web_fetch",
  "phenix_workflow",
];

function resolveTurnBudget(config: RuntimePolicyConfig): TurnBudget {
  const configured = config.execution?.turnBudget;
  if (!configured) return {};

  const maxTurns = configured.maxTurns;
  const graceTurns = configured.graceTurns;
  if (maxTurns === undefined) {
    if (graceTurns !== undefined) {
      throw new Error("execution.turnBudget.graceTurns requires maxTurns");
    }
    return {};
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("execution.turnBudget.maxTurns must be a positive integer");
  }
  if (graceTurns !== undefined && (!Number.isInteger(graceTurns) || graceTurns < 0)) {
    throw new Error("execution.turnBudget.graceTurns must be a non-negative integer");
  }

  return {
    maxTurns,
    ...(graceTurns !== undefined ? { graceTurns } : {}),
  };
}

function resolveToolBudget(tier: ModelTier, config: RuntimePolicyConfig): ToolBudget {
  const configured = config.execution?.toolBudget;
  const hard = configured?.hard;
  if (hard !== undefined && (!Number.isInteger(hard) || hard < 1)) {
    throw new Error("execution.toolBudget.hard must be a positive integer");
  }

  const tierSoft = TIER_BUDGETS[tier].advisoryTools;
  const soft = configured?.soft ?? (hard === undefined ? tierSoft : Math.min(tierSoft, hard));
  if (!Number.isInteger(soft) || soft < 1) {
    throw new Error("execution.toolBudget.soft must be a positive integer");
  }
  if (hard !== undefined && soft > hard) {
    throw new Error("execution.toolBudget.soft must be less than or equal to hard");
  }

  return {
    soft,
    ...(hard !== undefined ? { hard } : {}),
    block: BLOCKED_AFTER_HARD_LIMIT,
  };
}

// ── Policy resolution ──────────────────────────────────────────────────────

export function resolveExecutionPolicy(input: {
  readonly role: AgentRole;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly profileHint?: ProfileHint;
  readonly cwd: string;
  readonly config?: RuntimePolicyConfig;
}): ResolvedExecutionPolicy {
  const config = input.config ?? loadPolicyConfig();
  const preset = rolePreset(input.role);

  // 1. Derive task profile using preset minimums.
  const profile = deriveTaskProfile(input.role, input.task, input.requirements, input.profileHint);

  // 2. Derive tier.
  const tier = tierForProfile(profile);

  // 3. Select thinking from the preset.
  const thinking = preset.thinking[tier];

  // 4. Derive budgets.
  const budget = TIER_BUDGETS[tier];

  // 5. Derive verification commands.
  const commands = verificationCommands(input.role, input.cwd, config);

  // 6. Max repair attempts.
  const maxRepairAttempts = Math.max(0, Math.min(3, config.verification?.maxRepairAttempts ?? 1));

  return {
    role: input.role,
    agent: preset.agentName,
    profile,
    tier,
    thinking,
    timeoutMs: budget.timeout,
    turnBudget: resolveTurnBudget(config),
    toolBudget: resolveToolBudget(tier, config),
    verificationCommands: commands,
    criticRequired: preset.criticRequired,
    maxRepairAttempts,
    allowedChildren: preset.allowedChildren,
  };
}

// ── Environment helpers ────────────────────────────────────────────────────

// In the Pi-native child-session architecture, the child agent role is
// determined by the contract artifact, not by environment variables.
// This function is retained for backward compatibility but always returns
// "root" since PI_SUBAGENT_CHILD_AGENT is no longer set.
export function roleFromEnvironment(): AgentKind | "root" {
  return "root";
}
