import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_KINDS = [
  "scout",
  "planner",
  "architect",
  "implementer",
  "tester",
  "critic",
  "finalizer",
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelTier = "low" | "standard" | "high" | "critical";

export interface TaskProfile {
  readonly complexity: number;
  readonly uncertainty: number;
  readonly consequence: number;
  readonly breadth: number;
  readonly coupling: number;
  readonly novelty: number;
}

export interface ProfileHint {
  readonly complexity?: number;
  readonly uncertainty?: number;
  readonly consequence?: number;
  readonly breadth?: number;
  readonly coupling?: number;
  readonly novelty?: number;
}

export interface VerificationCommand {
  readonly id: string;
  readonly command: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly allowFailure?: boolean;
}

interface VerificationConfig {
  readonly maxRepairAttempts?: number;
  readonly timeoutMs?: number;
  readonly extraCommands?: readonly VerificationCommand[];
  readonly roleCommands?: Partial<Record<AgentKind, readonly VerificationCommand[]>>;
}

export interface RuntimePolicyConfig {
  readonly verification?: VerificationConfig;
}

export interface ResolvedExecutionPolicy {
  readonly agent: `phenix.${AgentKind}`;
  readonly role: AgentKind;
  readonly profile: TaskProfile;
  readonly tier: ModelTier;
  readonly model?: string;
  readonly thinking: ThinkingLevel;
  readonly timeoutMs: number;
  readonly turnBudget: { readonly maxTurns: number; readonly graceTurns: number };
  readonly toolBudget: {
    readonly soft: number;
    readonly hard: number;
    readonly block: readonly string[];
  };
  readonly expectedAcceptance: "not-required";
  readonly acceptance: Record<string, unknown>;
  readonly verificationCommands: readonly VerificationCommand[];
  readonly criticRequired: boolean;
  readonly maxRepairAttempts: number;
  readonly allowedTools: readonly string[];
  readonly allowedChildren: readonly AgentKind[];

  // Routing fields (added by phenix-routing integration)
  readonly modelSet?: string;
  readonly difficulty?: string;
  readonly capability?: string;
  readonly candidatePool?: string;
  readonly candidateIndex?: number;
}

const ROLE_CHILDREN: Record<AgentKind, readonly AgentKind[]> = {
  scout: ["scout"],
  planner: ["scout", "architect", "critic"],
  architect: ["scout", "critic"],
  implementer: ["scout", "tester", "critic"],
  tester: ["scout"],
  critic: ["scout", "tester"],
  finalizer: ["critic"],
};

const COMMON_READ_TOOLS = [
  "read",
  "grep",
  "search",
  "find",
  "ls",
  "tree",
  "bash",
  "lsp",
  "lsp_*",
  "ast_grep",
  "ast_*",
  "mcp",
  "mcp_*",
  "web_search",
  "web_fetch",
  "fetch_content",
  "get_search_content",
  "context_info",
  "context_*",
  "structured_output",
  "contact_supervisor",
  "phenix_delegate",
  "phenix_agent",
] as const;

const ROLE_TOOLS: Record<AgentKind, readonly string[]> = {
  scout: COMMON_READ_TOOLS,
  planner: COMMON_READ_TOOLS,
  architect: COMMON_READ_TOOLS,
  implementer: [
    ...COMMON_READ_TOOLS,
    "edit",
    "write",
    "apply_patch",
    "ast_edit",
    "todo",
  ],
  tester: COMMON_READ_TOOLS,
  critic: COMMON_READ_TOOLS,
  finalizer: COMMON_READ_TOOLS,
};

const THINKING: Record<AgentKind, Record<ModelTier, ThinkingLevel>> = {
  scout: { low: "low", standard: "low", high: "medium", critical: "high" },
  planner: { low: "medium", standard: "medium", high: "high", critical: "xhigh" },
  architect: { low: "medium", standard: "high", high: "high", critical: "xhigh" },
  implementer: { low: "low", standard: "medium", high: "high", critical: "high" },
  tester: { low: "low", standard: "low", high: "medium", critical: "high" },
  critic: { low: "medium", standard: "high", high: "high", critical: "xhigh" },
  finalizer: { low: "low", standard: "medium", high: "medium", critical: "high" },
};

const ROLE_MINIMUMS: Record<AgentKind, Partial<TaskProfile>> = {
  scout: { uncertainty: 1 },
  planner: { complexity: 2, breadth: 1 },
  architect: { complexity: 2, coupling: 2, consequence: 1 },
  implementer: { complexity: 1 },
  tester: { consequence: 1 },
  critic: { consequence: 2, uncertainty: 1 },
  finalizer: { breadth: 1 },
};

const DEFAULT_CONFIG: RuntimePolicyConfig = {
  verification: {
    maxRepairAttempts: 1,
    timeoutMs: 180_000,
    extraCommands: [],
    roleCommands: {},
  },
};

function clampScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(4, Math.round(value)));
}

function maxScore(...values: Array<number | undefined>): number {
  return Math.max(0, ...values.map((value) => value ?? 0));
}

function mergeObjects<T extends Record<string, unknown>>(base: T, overlay: unknown): T {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base;
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = output[key];
    if (
      previous &&
      typeof previous === "object" &&
      !Array.isArray(previous) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      output[key] = mergeObjects(previous as Record<string, unknown>, value);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}

function readJson(candidate: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(candidate, "utf-8"));
  } catch {
    return undefined;
  }
}

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

export function deriveTaskProfile(
  role: AgentKind,
  task: string,
  requirements: readonly string[],
  hint: ProfileHint = {},
): TaskProfile {
  const text = `${task}\n${requirements.join("\n")}`.toLowerCase();
  const minimum = ROLE_MINIMUMS[role];
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function verificationCommands(
  role: AgentKind,
  cwd: string,
  config: RuntimePolicyConfig,
): VerificationCommand[] {
  const scriptPath = fileURLToPath(new URL("../../runtime/verify.mjs", import.meta.url));
  const commands: VerificationCommand[] = [];

  if (role === "implementer" || role === "tester") {
    commands.push({
      id: "phenix-runtime-verification",
      command: `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} --cwd ${shellQuote(cwd)}`,
      cwd,
      timeoutMs: config.verification?.timeoutMs ?? 180_000,
    });
  }

  for (const command of config.verification?.extraCommands ?? []) commands.push(command);
  for (const command of config.verification?.roleCommands?.[role] ?? []) commands.push(command);
  return commands;
}

function acceptanceFor(): {
  expected: "not-required";
  config: Record<string, unknown>;
} {
  return {
    expected: "not-required",
    config: {
      level: "none",
      reason: "Phenix owns structural validation, executable verification, and critic gates in the runtime.",
    },
  };
}

function criticRequired(role: AgentKind): boolean {
  return role === "planner" || role === "architect" || role === "implementer";
}

export function resolveExecutionPolicy(input: {
  readonly role: AgentKind;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly profileHint?: ProfileHint;
  readonly cwd: string;
  readonly config?: RuntimePolicyConfig;
}): ResolvedExecutionPolicy {
  const config = input.config ?? loadPolicyConfig();
  const profile = deriveTaskProfile(
    input.role,
    input.task,
    input.requirements,
    input.profileHint,
  );
  const tier = tierForProfile(profile);
  const commands = verificationCommands(input.role, input.cwd, config);
  const acceptance = acceptanceFor();
  const budgets: Record<ModelTier, { turns: number; tools: number; timeout: number }> = {
    low: { turns: 12, tools: 40, timeout: 10 * 60_000 },
    standard: { turns: 24, tools: 80, timeout: 20 * 60_000 },
    high: { turns: 40, tools: 140, timeout: 35 * 60_000 },
    critical: { turns: 64, tools: 220, timeout: 60 * 60_000 },
  };
  const budget = budgets[tier];

  return {
    agent: `phenix.${input.role}`,
    role: input.role,
    profile,
    tier,
    thinking: THINKING[input.role][tier],
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
        "phenix_delegate"
      ],
    },
    expectedAcceptance: acceptance.expected,
    acceptance: acceptance.config,
    verificationCommands: commands,
    criticRequired: criticRequired(input.role),
    maxRepairAttempts: Math.max(
      0,
      Math.min(3, config.verification?.maxRepairAttempts ?? 1),
    ),
    allowedTools: ROLE_TOOLS[input.role],
    allowedChildren: ROLE_CHILDREN[input.role],
  };
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

export function roleFromEnvironment(): AgentKind | "root" {
  const raw = process.env.PI_SUBAGENT_CHILD_AGENT?.trim();
  if (!raw) return "root";
  const candidate = raw.startsWith("phenix.") ? raw.slice("phenix.".length) : raw;
  return isAgentKind(candidate) ? candidate : "root";
}

function matchTool(pattern: string, toolName: string): boolean {
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

export function toolAllowed(role: AgentKind | "root", toolName: string): boolean {
  if (toolName === "subagent") return false;
  if (role === "root") return true;
  return ROLE_TOOLS[role].some((pattern) => matchTool(pattern, toolName));
}

export function childAllowed(parent: AgentKind | "root", child: AgentKind): boolean {
  if (parent === "root") return true;
  return ROLE_CHILDREN[parent].includes(child);
}
