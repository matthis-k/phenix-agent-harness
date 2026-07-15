import type { AgentKind, AgentRole, ModelTier, TaskProfile, ThinkingLevel } from "./agent-types.ts";

// ── Role preset interface ───────────────────────────────────────────────────

export interface RolePreset {
  readonly agentName: `phenix.${AgentKind}` | "phenix.base";

  readonly tools: readonly string[];
  readonly allowedChildren: readonly AgentKind[];

  readonly profileMinimums: Readonly<Partial<TaskProfile>>;

  readonly thinking: Readonly<Record<ModelTier, ThinkingLevel>>;

  readonly criticRequired: boolean;
}

// ── Common read tools (shared by most roles) ────────────────────────────────

const COMMON_READ_TOOLS: readonly string[] = [
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
  "contact_supervisor",
  "phenix_workflow",
  "phenix_create_subagent",
] as const;

// ── Role presets ────────────────────────────────────────────────────────────

const SCOUT_PRESET: RolePreset = {
  agentName: "phenix.scout",
  tools: COMMON_READ_TOOLS,
  allowedChildren: ["scout"],
  profileMinimums: { uncertainty: 1 },
  thinking: {
    low: "low",
    standard: "low",
    high: "medium",
    critical: "high",
  },
  criticRequired: false,
};

const PLANNER_PRESET: RolePreset = {
  agentName: "phenix.planner",
  tools: COMMON_READ_TOOLS,
  allowedChildren: ["scout", "architect", "critic"],
  profileMinimums: { complexity: 2, breadth: 1 },
  thinking: {
    low: "medium",
    standard: "medium",
    high: "high",
    critical: "xhigh",
  },
  criticRequired: true,
};

const ARCHITECT_PRESET: RolePreset = {
  agentName: "phenix.architect",
  tools: COMMON_READ_TOOLS,
  allowedChildren: ["scout", "critic"],
  profileMinimums: { complexity: 2, coupling: 2, consequence: 1 },
  thinking: {
    low: "medium",
    standard: "high",
    high: "high",
    critical: "xhigh",
  },
  criticRequired: true,
};

const IMPLEMENTER_PRESET: RolePreset = {
  agentName: "phenix.implementer",
  tools: [...COMMON_READ_TOOLS, "edit", "write", "apply_patch", "ast_edit", "todo"],
  allowedChildren: ["scout", "tester", "critic"],
  profileMinimums: { complexity: 1 },
  thinking: {
    low: "low",
    standard: "medium",
    high: "high",
    critical: "high",
  },
  criticRequired: true,
};

const TESTER_PRESET: RolePreset = {
  agentName: "phenix.tester",
  tools: COMMON_READ_TOOLS,
  allowedChildren: ["scout"],
  profileMinimums: { consequence: 1 },
  thinking: {
    low: "low",
    standard: "low",
    high: "medium",
    critical: "high",
  },
  criticRequired: false,
};

const CRITIC_PRESET: RolePreset = {
  agentName: "phenix.critic",
  tools: COMMON_READ_TOOLS,
  allowedChildren: ["scout", "tester"],
  profileMinimums: { consequence: 2, uncertainty: 1 },
  thinking: {
    low: "medium",
    standard: "high",
    high: "high",
    critical: "xhigh",
  },
  criticRequired: false,
};

const FINALIZER_PRESET: RolePreset = {
  agentName: "phenix.finalizer",
  tools: COMMON_READ_TOOLS,
  allowedChildren: ["critic"],
  profileMinimums: { breadth: 1 },
  thinking: {
    low: "low",
    standard: "medium",
    high: "medium",
    critical: "high",
  },
  criticRequired: false,
};

const ROLE_PRESETS: Record<AgentKind, RolePreset> = {
  scout: SCOUT_PRESET,
  planner: PLANNER_PRESET,
  architect: ARCHITECT_PRESET,
  implementer: IMPLEMENTER_PRESET,
  tester: TESTER_PRESET,
  critic: CRITIC_PRESET,
  finalizer: FINALIZER_PRESET,
};

const EMPTY_ROLE_PRESET: RolePreset = {
  agentName: "phenix.base",
  tools: [],
  allowedChildren: [],
  profileMinimums: {},
  thinking: {
    low: "low",
    standard: "medium",
    high: "high",
    critical: "high",
  },
  criticRequired: false,
} as const;

// ── Preset lookup ───────────────────────────────────────────────────────────

export function rolePreset(role: AgentRole): RolePreset {
  if (role === null) return EMPTY_ROLE_PRESET;
  return ROLE_PRESETS[role as AgentKind];
}
