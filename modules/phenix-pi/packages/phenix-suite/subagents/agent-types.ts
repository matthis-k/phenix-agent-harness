// ── Re-exports from kernel (canonical definitions) ─────────────────────────

export type {
  AgentKind,
  AgentRole,
} from "@matthis-k/phenix-kernel/agents.ts";

export {
  AGENT_KINDS,
  isAgentKind,
} from "@matthis-k/phenix-kernel/agents.ts";

export type {
  Difficulty,
  ProfileHint,
  TaskProfile,
  ThinkingLevel,
} from "@matthis-k/phenix-kernel/task.ts";

// ── Subagent-local types ──────────────────────────────────────────────────

export type ModelTier = "low" | "standard" | "high" | "critical";

export interface TurnBudget {
  /** Optional hard cap. Omit it for open-ended work such as repository QA. */
  readonly maxTurns?: number;
  /** Additional turns allowed after an explicit hard cap. */
  readonly graceTurns?: number;
}

export interface ToolBudget {
  readonly soft: number;
  readonly hard: number;
  readonly block: readonly string[];
}

export interface VerificationCommand {
  readonly id: string;
  readonly command: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly allowFailure?: boolean;
}
