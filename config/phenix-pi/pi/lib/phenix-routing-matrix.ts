/**
 * phenix-routing-matrix.ts — Central routing matrix for Phenix workflow routing.
 *
 * Maps variant × difficulty × costMode → chain name + per-role model/thinking.
 *
 * This is the single source of truth for model selection. The /flow command
 * and any Phenix chain invocations use this to resolve which model each role
 * should use and which chain file to invoke.
 *
 * Rules:
 *   free   → opencode/deepseek-v4-flash-free only; vary thinking; deny sensitive work
 *   opencode-go → exact model IDs from known OpenCode Go model list
 *   gpt    → capability aliases (fast/thinking/pro) resolved against available GPT models
 *   mixed  → Go for scout/implementer, GPT for D2/D3 planner/verifier
 */

// ══════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════

export type Variant = "free" | "opencode-go" | "gpt" | "mixed";
export type Difficulty = "D0" | "D1" | "D2" | "D3";
export type CostMode = "economy" | "balanced" | "quality";
export type Thinking = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Role =
  | "scout"
  | "planner"
  | "critic"
  | "implementer"
  | "verifier"
  | "reviewer"
  | "final_reviewer";
export type Secrecy = "public" | "private" | "secret";
export type ChangeKind =
  | "typo"
  | "refactor"
  | "feature"
  | "bugfix"
  | "test"
  | "docs"
  | "config"
  | "ci"
  | "security"
  | "auth"
  | "permissions"
  | "deployment"
  | "architecture"
  | "unknown";
export type TargetState = "scratch" | "dev-wallet" | "main-bound";

export interface RoleRoute {
  enabled: boolean;
  model: string;
  thinking: Thinking;
}

export interface WorkflowRoute {
  allowed: boolean;
  denialReason?: string;
  variant: Variant;
  difficulty: Difficulty;
  costMode: CostMode;
  chain: string;
  roles: Partial<Record<Role, RoleRoute>>;
  warnings: string[];
}

// ══════════════════════════════════════════════
// MODEL LISTS
// ══════════════════════════════════════════════

/** All known OpenCode Go model IDs used by the routing matrix. */
export const OPENCODE_GO_MODELS: string[] = [
  "opencode-go/glm-5.2",
  "opencode-go/glm-5.1",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/kimi-k2.6",
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/minimax-m3",
  "opencode-go/minimax-m2.7",
  "opencode-go/minimax-m2.5",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
  "opencode-go/qwen3.6-plus",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/deepseek-v4-flash",
];

/** GPT capability alias preference lists. */
export const GPT_CAPABILITY_PREFERENCES: Record<string, string[]> = {
  fast: ["openai/gpt-5.5-instant", "openai/gpt-5.5", "openai/gpt-5.5-thinking"],
  thinking: ["openai/gpt-5.5-thinking", "openai/gpt-5.5"],
  pro: ["openai/gpt-5.5-pro", "openai/gpt-5.5-thinking", "openai/gpt-5.5"],
};

/** Denied change kinds for free mode. */
const FREE_DENIED_CHANGE_KINDS: ChangeKind[] = [
  "security", "auth", "ci", "permissions", "deployment",
];

// ══════════════════════════════════════════════
// OPENCODE-GO ROUTING
// ══════════════════════════════════════════════

const OPENCODE_GO_ROLES: Record<Difficulty, Partial<Record<Role, RoleRoute>>> = {
  D0: {
    implementer: { enabled: true, model: "opencode-go/deepseek-v4-flash", thinking: "low" },
  },
  D1: {
    scout: { enabled: true, model: "opencode-go/deepseek-v4-flash", thinking: "low" },
    planner: { enabled: true, model: "opencode-go/qwen3.7-plus", thinking: "medium" },
    implementer: { enabled: true, model: "opencode-go/kimi-k2.7-code", thinking: "low" },
    verifier: { enabled: true, model: "opencode-go/deepseek-v4-pro", thinking: "medium" },
  },
  D2: {
    scout: { enabled: true, model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
    planner: { enabled: true, model: "opencode-go/glm-5.1", thinking: "high" },
    critic: { enabled: true, model: "opencode-go/deepseek-v4-pro", thinking: "medium" },
    implementer: { enabled: true, model: "opencode-go/kimi-k2.7-code", thinking: "medium" },
    verifier: { enabled: true, model: "opencode-go/glm-5.1", thinking: "high" },
  },
  D3: {
    scout: { enabled: true, model: "opencode-go/deepseek-v4-pro", thinking: "high" },
    planner: { enabled: true, model: "opencode-go/glm-5.2", thinking: "xhigh" },
    critic: { enabled: true, model: "opencode-go/qwen3.7-max", thinking: "high" },
    implementer: { enabled: true, model: "opencode-go/kimi-k2.7-code", thinking: "high" },
    verifier: { enabled: true, model: "opencode-go/glm-5.2", thinking: "xhigh" },
    final_reviewer: { enabled: true, model: "opencode-go/glm-5.2", thinking: "xhigh" },
  },
};

// ══════════════════════════════════════════════
// FREE ROUTING
// ══════════════════════════════════════════════

const FREE_ROLES: Record<Difficulty, Partial<Record<Role, RoleRoute>>> = {
  D0: {
    implementer: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "low" },
  },
  D1: {
    scout: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "low" },
    planner: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "medium" },
    implementer: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "low" },
    verifier: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "medium" },
  },
  D2: {
    scout: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "medium" },
    planner: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "high" },
    implementer: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "medium" },
    verifier: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "high" },
  },
  D3: {
    scout: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "high" },
    planner: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "xhigh" },
    implementer: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "high" },
    verifier: { enabled: true, model: "opencode/deepseek-v4-flash-free", thinking: "xhigh" },
  },
};

// ══════════════════════════════════════════════
// GPT ROUTING
// ══════════════════════════════════════════════

const GPT_ROLES: Record<Difficulty, Partial<Record<Role, RoleRoute>>> = {
  D0: {
    implementer: { enabled: true, model: "fast", thinking: "low" },
  },
  D1: {
    scout: { enabled: true, model: "fast", thinking: "low" },
    planner: { enabled: true, model: "thinking", thinking: "medium" },
    implementer: { enabled: true, model: "fast", thinking: "low" },
    verifier: { enabled: true, model: "thinking", thinking: "medium" },
  },
  D2: {
    scout: { enabled: true, model: "fast", thinking: "medium" },
    planner: { enabled: true, model: "thinking", thinking: "high" },
    implementer: { enabled: true, model: "fast", thinking: "medium" },
    verifier: { enabled: true, model: "thinking", thinking: "high" },
  },
  D3: {
    scout: { enabled: true, model: "thinking", thinking: "high" },
    planner: { enabled: true, model: "thinking", thinking: "high" },
    implementer: { enabled: true, model: "thinking", thinking: "high" },
    verifier: { enabled: true, model: "thinking", thinking: "high" },
    final_reviewer: { enabled: true, model: "pro", thinking: "xhigh" },
  },
};

// ══════════════════════════════════════════════
// MIXED ROUTING
// ══════════════════════════════════════════════

const MIXED_ROLES: Record<Difficulty, Partial<Record<Role, RoleRoute>>> = {
  D0: {
    implementer: { enabled: true, model: "opencode-go/deepseek-v4-flash", thinking: "low" },
  },
  D1: {
    scout: { enabled: true, model: "opencode-go/deepseek-v4-flash", thinking: "low" },
    planner: { enabled: true, model: "opencode-go/qwen3.7-plus", thinking: "medium" },
    implementer: { enabled: true, model: "opencode-go/kimi-k2.7-code", thinking: "low" },
    verifier: { enabled: true, model: "opencode-go/deepseek-v4-pro", thinking: "medium" },
  },
  D2: {
    scout: { enabled: true, model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
    planner: { enabled: true, model: "gpt/thinking", thinking: "high" },
    implementer: { enabled: true, model: "opencode-go/kimi-k2.7-code", thinking: "medium" },
    verifier: { enabled: true, model: "gpt/thinking", thinking: "high" },
  },
  D3: {
    scout: { enabled: true, model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
    planner: { enabled: true, model: "gpt/thinking", thinking: "high" },
    implementer: { enabled: true, model: "opencode-go/kimi-k2.7-code", thinking: "high" },
    verifier: { enabled: true, model: "gpt/thinking", thinking: "high" },
    final_reviewer: { enabled: true, model: "gpt/pro", thinking: "xhigh" },
  },
};

// ══════════════════════════════════════════════
// CHAIN NAME MAP
// ══════════════════════════════════════════════

function chainForDifficulty(difficulty: Difficulty): string {
  switch (difficulty) {
    case "D0": return "phenix-d0";
    case "D1": return "phenix-d1";
    case "D2": return "phenix-d2";
    case "D3": return "phenix-d3";
  }
}

// ══════════════════════════════════════════════
// COST MODE ADJUSTMENTS
// ══════════════════════════════════════════════

/**
 * Apply costMode adjustments to role model assignments.
 *
 * quality:   No changes — use as-is.
 * balanced:  D3 GLM-5.2 → GLM-5.1 for non-final roles.
 * economy:   Avoid GLM-5.2/5.1 and Qwen3.7 Max. Use flash/pro/kimi.
 */
function applyCostMode(
  roles: Partial<Record<Role, RoleRoute>>,
  costMode: CostMode,
): Partial<Record<Role, RoleRoute>> {
  if (costMode === "quality") return roles;

  const result: Partial<Record<Role, RoleRoute>> = {};

  for (const [role, route] of Object.entries(roles)) {
    if (!route || !route.enabled) {
      result[role as Role] = route;
      continue;
    }

    let model = route.model;

    if (costMode === "balanced") {
      if (model === "opencode-go/glm-5.2" && role !== "final_reviewer") {
        model = "opencode-go/glm-5.1";
      }
    } else if (costMode === "economy") {
      if (model === "opencode-go/glm-5.2" || model === "opencode-go/glm-5.1") {
        model = "opencode-go/deepseek-v4-pro";
      }
      if (model === "opencode-go/qwen3.7-max") {
        model = "opencode-go/deepseek-v4-pro";
      }
    }

    result[role as Role] = { ...route, model };
  }

  return result;
}

// ══════════════════════════════════════════════
// AVAILABLE MODEL FALLBACK
// ══════════════════════════════════════════════

/**
 * Resolve a GPT capability alias against available model IDs.
 * Falls back to the first available preference, or openai/gpt-5.5.
 */
export function resolveGptCapability(
  capability: string,
  availableModels: string[],
): string {
  const prefs = GPT_CAPABILITY_PREFERENCES[capability];
  if (!prefs) return "openai/gpt-5.5";
  for (const modelId of prefs) {
    if (availableModels.includes(modelId)) return modelId;
  }
  return "openai/gpt-5.5";
}

/**
 * Resolve a model ID with fallback for a given role.
 * Walks the model search list if the assigned model is not available.
 */
export function resolveModelWithFallback(
  model: string,
  _role: Role,
  searchList: string[],
): string {
  if (searchList.includes(model)) return model;
  // Try the first available model from the search list
  if (searchList.length > 0) return searchList[0];
  return "opencode-go/deepseek-v4-flash";
}

// ══════════════════════════════════════════════
// ROLE → AGENT NAME MAP
// ══════════════════════════════════════════════

/**
 * Map a routing role to the pi-subagents agent name.
 * Phenix agents use the "phenix-" prefix to distinguish from builtin agents.
 */
export function roleToAgent(role: Role): string {
  switch (role) {
    case "scout": return "phenix-scout";
    case "planner": return "phenix-planner";
    case "critic": return "phenix-reviewer";
    case "implementer": return "phenix-worker";
    case "verifier": return "phenix-verifier";
    case "reviewer": return "phenix-reviewer";
    case "final_reviewer": return "phenix-reviewer";
  }
}

// ══════════════════════════════════════════════
// DENIAL POLICIES
// ══════════════════════════════════════════════

interface DenialInput {
  variant: Variant;
  difficulty: Difficulty;
  secrecy: Secrecy;
  changeKind: ChangeKind;
  targetState: TargetState;
}

function checkDenial(input: DenialInput): string | null {
  const { variant, changeKind, secrecy, targetState } = input;

  // Free mode restrictions
  if (variant === "free") {
    if (secrecy === "secret" || secrecy === "private") {
      return `Free mode cannot handle ${secrecy} work.`;
    }
    if (FREE_DENIED_CHANGE_KINDS.includes(changeKind)) {
      return `Free mode denied for change kind "${changeKind}". Requires stronger model.`;
    }
    if (targetState === "main-bound") {
      return "Free mode cannot be used for main-bound work.";
    }
  }

  // Main-bound safety: require at least D1 verification for main-bound
  if (targetState === "main-bound" && input.difficulty === "D0") {
    return "Main-bound target requires at least D1 difficulty for proper verification.";
  }

  return null;
}

// ══════════════════════════════════════════════
// MAIN ENTRY POINT
// ══════════════════════════════════════════════

export interface ResolveWorkflowRouteInput {
  variant: Variant;
  difficulty: Difficulty;
  costMode: CostMode;
  secrecy: Secrecy;
  changeKind: ChangeKind;
  targetState: TargetState;
  /** Available model IDs for GPT capability resolution. Optional; defaults to ["openai/gpt-5.5"]. */
  gptAvailableModels?: string[];
  /** Complete list of available model IDs for fallback. Optional. */
  allAvailableModels?: string[];
}

/**
 * Resolve the workflow route for a given variant × difficulty × costMode.
 *
 * Returns a WorkflowRoute with:
 * - Chain name to invoke
 * - Per-role model/thinking assignments
 * - Denial information if not allowed
 * - Warnings
 */
export function resolveWorkflowRoute(
  input: ResolveWorkflowRouteInput,
): WorkflowRoute {
  const { variant, difficulty, costMode, secrecy, changeKind, targetState, gptAvailableModels, allAvailableModels } = input;

  // Check denial policies
  const denialReason = checkDenial({
    variant, difficulty, secrecy, changeKind, targetState,
  });
  if (denialReason) {
    return {
      allowed: false,
      denialReason,
      variant,
      difficulty,
      costMode,
      chain: chainForDifficulty(difficulty),
      roles: {},
      warnings: [denialReason],
    };
  }

  // Get base roles
  const baseRoles = getBaseRoles(variant, difficulty);
  if (!baseRoles) {
    return {
      allowed: false,
      denialReason: `No routing defined for ${variant}/${difficulty}`,
      variant,
      difficulty,
      costMode,
      chain: chainForDifficulty(difficulty),
      roles: {},
      warnings: [],
    };
  }

  // Apply cost mode adjustments
  let adjustedRoles = applyCostMode(baseRoles, costMode);

  // Resolve capability aliases against available models
  const gptModels = gptAvailableModels ?? ["openai/gpt-5.5"];
  const allModels = allAvailableModels ?? OPENCODE_GO_MODELS;

  const resolvedRoles: Partial<Record<Role, RoleRoute>> = {};
  for (const [role, route] of Object.entries(adjustedRoles)) {
    if (!route || !route.enabled) {
      resolvedRoles[role as Role] = route;
      continue;
    }
    let model = route.model;
    const roleType = role as Role;

    // Resolve GPT capability aliases
    const gptPrefix = "gpt/";
    if (model.startsWith(gptPrefix)) {
      model = resolveGptCapability(model.slice(gptPrefix.length), gptModels);
    } else if (variant === "gpt") {
      // In GPT variant, bare model names are capability aliases
      model = resolveGptCapability(model, gptModels);
    }

    // Resolve OpenCode Go models with fallback
    if (model.startsWith("opencode-go/")) {
      model = resolveModelWithFallback(model, roleType, allModels);
    }

    resolvedRoles[roleType] = { ...route, model };
  }

  // Build warnings
  const warnings: string[] = [];
  if (variant === "free" && (difficulty === "D2" || difficulty === "D3")) {
    warnings.push("Free mode with higher difficulty may not be sufficient for complex work.");
  }

  return {
    allowed: true,
    variant,
    difficulty,
    costMode,
    chain: chainForDifficulty(difficulty),
    roles: resolvedRoles,
    warnings,
  };
}

// ══════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════

const VARIANT_ROLES: Record<Variant, Record<Difficulty, Partial<Record<Role, RoleRoute>>>> = {
  "opencode-go": OPENCODE_GO_ROLES,
  free: FREE_ROLES,
  gpt: GPT_ROLES,
  mixed: MIXED_ROLES,
};

function getBaseRoles(
  variant: Variant,
  difficulty: Difficulty,
): Partial<Record<Role, RoleRoute>> | undefined {
  return VARIANT_ROLES[variant]?.[difficulty];
}

// ══════════════════════════════════════════════
// CONVENIENCE: classify then route
// ══════════════════════════════════════════════

/**
 * Classify difficulty from prompt text.
 */
export function classifyDifficulty(prompt: string): Difficulty {
  const lower = prompt.toLowerCase();
  if (
    /\b(d0|typo|rename|trivial|obvious|mechanical|formatting)\b/i.test(lower)
  )
    return "D0";
  if (
    /\b(d3|high.risk|ambiguous|security|secret|main.bound|release|cross.repo)\b/i.test(lower)
  )
    return "D3";
  if (
    /\b(d2|architect|multi.file|cross.module|complex|refactor|restructur|redesign)\b/i.test(lower)
  )
    return "D2";
  return "D1";
}

/**
 * Classify secrecy from prompt text.
 */
export function classifySecrecy(_prompt: string): Secrecy {
  // Default to public — full classification requires user/provider input
  return "public";
}

/**
 * Classify change kind from prompt text.
 */
export function classifyChangeKind(prompt: string): ChangeKind {
  const lower = prompt.toLowerCase();
  if (/\b(typo|spelling|rename|format)\b/i.test(lower)) return "typo";
  if (/\b(refactor|restructur|reorganize|clean)\b/i.test(lower)) return "refactor";
  if (/\b(feature|add|new)\b/i.test(lower)) return "feature";
  if (/\b(bug|fix|error|crash|failing|broken)\b/i.test(lower)) return "bugfix";
  if (/\b(test|spec|coverage)\b/i.test(lower)) return "test";
  if (/\b(doc|readme|comment)\b/i.test(lower)) return "docs";
  if (/\b(config|setting)\b/i.test(lower)) return "config";
  if (/\b(security|vuln|cve|exploit)\b/i.test(lower)) return "security";
  if (/\b(auth|oauth|login|token|credential)\b/i.test(lower)) return "auth";
  if (/\b(deploy|release|publish)\b/i.test(lower)) return "deployment";
  if (/\b(architect|design|cross.module|module)\b/i.test(lower)) return "architecture";
  return "unknown";
}

/**
 * Full classification + routing in one call.
 */
export function classifyAndRoute(input: {
  prompt: string;
  variant: Variant;
  difficulty?: Difficulty;
  costMode: CostMode;
  targetState: TargetState;
  gptAvailableModels?: string[];
  allAvailableModels?: string[];
}): WorkflowRoute {
  const difficulty = input.difficulty ?? classifyDifficulty(input.prompt);
  return resolveWorkflowRoute({
    variant: input.variant,
    difficulty,
    costMode: input.costMode,
    secrecy: classifySecrecy(input.prompt),
    changeKind: classifyChangeKind(input.prompt),
    targetState: input.targetState,
    gptAvailableModels: input.gptAvailableModels,
    allAvailableModels: input.allAvailableModels,
  });
}
