import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeObjects, readJson } from "../phenix-shared.ts";
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

function clampScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(4, Math.round(value)));
}

function maxScore(...values: Array<number | undefined>): number {
  return Math.max(0, ...values.map((value) => value ?? 0));
}

export function deriveTaskProfile(
  role: AgentRole,
  task: string,
  requirements: readonly string[],
  hint: ProfileHint = {},
): TaskProfile {
  const text = `${task}\n${requirements.join("\n")}`.toLowerCase();
  const preset = rolePreset(role);
  const minimum = preset.profileMinimums;

  const highRisk = /\b(security|auth|permission|secret|credential|migration|data loss|destructive|concurren|race|deadlock|protocol|public api)\b/.test(text);
  const architecture = /\b(architect|redesign|state machine|workflow|persistent|database|schema|interface|cross[- ]cutting)\b/.test(text);
  const uncertainty = /\b(investigate|unknown|unclear|research|diagnose|why|root cause)\b/.test(text);
  const novelty = /\b(new|introduce|design|invent|prototype|replace)\b/.test(text);

  const inferred: TaskProfile = {
    complexity:
      task.length > 4_000 ? 4 : task.length > 1_800 ? 3 : task.length > 700 ? 2 : 1,
    uncertainty: uncertainty ? 2 : 0,
    consequence: highRisk ? 3 : 0,
    breadth: requirements.length >= 9 ? 4 : requirements.length >= 5 ? 3 : requirements.length >= 2 ? 2 : 0,
    coupling: architecture ? 3 : 0,
    novelty: novelty ? 2 : 0,
  };

  return {
    complexity: clampScore(maxScore(inferred.complexity, minimum.complexity, hint.complexity)),
    uncertainty: clampScore(maxScore(inferred.uncertainty, minimum.uncertainty, hint.uncertainty)),
    consequence: clampScore(maxScore(inferred.consequence, minimum.consequence, hint.consequence)),
    breadth: clampScore(maxScore(inferred.breadth, minimum.breadth, hint.breadth)),
    coupling: clampScore(maxScore(inferred.coupling, minimum.coupling, hint.coupling)),
    novelty: clampScore(maxScore(inferred.novelty, minimum.novelty, hint.novelty)),
  };
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

export function roleFromEnvironment(): AgentKind | "root" {
  const raw = process.env.PI_SUBAGENT_CHILD_AGENT?.trim();
  if (!raw) return "root";
  const candidate = raw.startsWith("phenix.") ? raw.slice("phenix.".length) : raw;
  return AGENT_KINDS.includes(candidate as AgentKind) ? (candidate as AgentKind) : "root";
}
