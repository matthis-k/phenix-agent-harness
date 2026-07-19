/**
 * phenix-kernel — shared agent vocabulary.
 *
 * These are semantic agent roles used by the deterministic workflow. Runtime
 * agent clients use AgentClientId/AgentClientRef from ids/refs.
 */

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

/** Null means the base/no-role execution client. */
export type AgentRole = AgentKind | null;

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && AGENT_KINDS.includes(value as AgentKind);
}

export function isAgentRole(value: unknown): value is AgentRole {
  return value === null || isAgentKind(value);
}
