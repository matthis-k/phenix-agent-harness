// ── Re-exports from kernel (canonical definitions) ─────────────────────────

export type {
  AgentKind,
  AgentRole,
} from "../phenix-kernel/agents.ts";

export {
  AGENT_KINDS,
  isAgentKind,
} from "../phenix-kernel/agents.ts";

export type {
  Difficulty,
  ProfileHint,
  TaskProfile,
  ThinkingLevel,
} from "../phenix-kernel/task.ts";

// ── Subagent-local types ──────────────────────────────────────────────────

export type ModelTier = "low" | "standard" | "high" | "critical";

export interface TurnBudget {
  readonly maxTurns: number;
  readonly graceTurns: number;
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
