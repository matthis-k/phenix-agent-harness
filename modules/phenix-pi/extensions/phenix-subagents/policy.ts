import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeObjects, readJson } from "../phenix-shared.ts";
import { deriveTaskProfileFromText } from "../phenix-kernel/task.ts";
import {
  AGENT_KINDS,
  type AgentKind,
  type AgentRole,
  type ModelTier,
  type ProfileHint,
  type TaskProfile,
  type ThinkingLevel,
  type TurnBudget,
  type ToolBudget,
  type VerificationCommand,
} from "./agent-types.ts";
import {
  rolePreset,
} from "./role-presets.ts";

export type {
  AgentKind,
  AgentRole,
  ModelTier,
  ProfileHint,
  TaskProfile,
  ThinkingLevel,
  TurnBudget,
  ToolBudget,
  VerificationCommand,
};

// ── Configuration types ─────────────────────────────────────────────────────

interface VerificationConfig {
  readonly maxRepairAttempts?: number;
  readonly timeoutMs?: number;
  readonly extraCommands?: readonly VerificationCommand[];
  readonly roleCommands?: Partial<Record<AgentKind, readonly VerificationCommand[]>>;
}

export interface RuntimePolicyConfig {
  readonly verification?: VerificationConfig;
}

// ── Resolved execution policy ────────────────────────────────────────────────

export interface ResolvedExecutionPolicy {
  readonly role: AgentRole;
  readonly agent:
    | `phenix.${AgentKind}`
    | "phenix.base";

  readonly profile: TaskProfile;
  readonly tier: ModelTier;

  readonly model?: string;
  readonly thinking: ThinkingLevel;

  readonly timeoutMs: number;
  readonly turnBudget: TurnBudget;
  readonly toolBudget: ToolBudget;

  readonly verificationCommands:
    readonly VerificationCommand[];

  readonly criticRequired: boolean;
  readonly maxRepairAttempts: number;
  readonly allowedChildren:
    readonly AgentKind[];

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
  const bundledPath = fileURLToPath(
    new URL("../../config/subagents.json", import.meta.url),
  );
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const userPath = path.join(agentDir, "phenix-subagents.json");
  const bundled = mergeObjects(
    DEFAULT_CONFIG as Record<string, unknown>,
    readJson(bundledPath),
  );
  return mergeObjects(
    bundled,
    readJson(userPath),
  ) as RuntimePolicyConfig;
}

// ── Profile derivation ──────────────────────────────────────────────────────

export function deriveTaskProfile(
  role: AgentRole,
  task: string,
  requirements: readonly string[],
  hint: ProfileHint = {},
): TaskProfile {
  const preset = rolePreset(role);
  return deriveTaskProfileFromText(
    task,
    requirements,
    hint,
    preset.profileMinimums,
  );
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

// ── Verification commands ───────────────────────────────────────────────────

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

const TIER_BUDGETS: Record<ModelTier, { turns: number; tools: number; timeout: number }> = {
  low: { turns: 12, tools: 40, timeout: 10 * 60_000 },
  standard: { turns: 24, tools: 80, timeout: 20 * 60_000 },
  high: { turns: 40, tools: 140, timeout: 35 * 60_000 },
  critical: { turns: 64, tools: 220, timeout: 60 * 60_000 },
};

// ── Policy resolution ───────────────────────────────────────────────────────

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
  const profile = deriveTaskProfile(
    input.role,
    input.task,
    input.requirements,
    input.profileHint,
  );

  // 2. Derive tier.
  const tier = tierForProfile(profile);

  // 3. Select thinking from the preset.
  const thinking = preset.thinking[tier];

  // 4. Derive budgets.
  const budget = TIER_BUDGETS[tier];

  // 5. Derive verification commands.
  const commands = verificationCommands(input.role, input.cwd, config);

  // 6. Max repair attempts.
  const maxRepairAttempts = Math.max(
    0,
    Math.min(3, config.verification?.maxRepairAttempts ?? 1),
  );

  return {
    role: input.role,
    agent: preset.agentName,
    profile,
    tier,
    thinking,
    timeoutMs: budget.timeout,
    turnBudget: { maxTurns: budget.turns, graceTurns: 2 },
    toolBudget: {
      soft: Math.max(1, Math.floor(budget.tools * 0.75)),
      hard: budget.tools,
      block: [
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
        "phenix_delegate",
      ],
    },
    verificationCommands: commands,
    criticRequired: preset.criticRequired,
    maxRepairAttempts,
    allowedChildren: preset.allowedChildren,
  };
}

// ── Environment helpers ─────────────────────────────────────────────────────

// In the Pi-native child-session architecture, the child agent role is
// determined by the contract artifact, not by environment variables.
// This function is retained for backward compatibility but always returns
// "root" since PI_SUBAGENT_CHILD_AGENT is no longer set.
export function roleFromEnvironment(): AgentKind | "root" {
  return "root";
}
