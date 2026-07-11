export const AGENT_KINDS = [
  "scout",
  "planner",
  "architect",
  "implementer",
  "tester",
  "critic",
  "finalizer",
] as const;

export type AgentKind =
  (typeof AGENT_KINDS)[number];

export type AgentRole = AgentKind | null;

export type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ModelTier =
  | "low"
  | "standard"
  | "high"
  | "critical";

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

export function isAgentKind(
  value: unknown,
): value is AgentKind {
  return (
    typeof value === "string" &&
    AGENT_KINDS.includes(value as AgentKind)
  );
}
