/**
 * Child route resolution adapter.
 *
 * Resolves a concrete route for a child agent using the same matrix,
 * model registry, config, and session model set as the root resolver.
 */

import type {
  Difficulty,
  ResolvedRoute,
  RoutingRole,
} from "./types.ts";

import {
  resolveRoute,
} from "./resolver.ts";

import type { AgentRole, AgentKind } from "../phenix-subagents/agent-types.ts";

import {
  getSessionRuntime,
} from "./state.ts";

import { modelRegistry } from "./registry.ts";

import {
  loadRoutingConfig,
} from "./config.ts";

// ── Role mapping ────────────────────────────────────────────────────────────

/**
 * Map an AgentRole to a RoutingRole for matrix lookup.
 * null (base) maps to "base".
 */
function agentRoleToRoutingRole(role: AgentRole): RoutingRole {
  if (role === null) return "base";
  return role as AgentKind;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve a route for a child agent using the current session's
 * model set, routing config, and the fixed role × difficulty matrix.
 *
 * The matched difficulty comes from the parent workflow — children
 * operate at the same difficulty level.
 */
export async function resolveChildRoute(
  input: {
    readonly sessionId: string;
    readonly role: AgentRole;
    readonly difficulty: Difficulty;
  },
): Promise<ResolvedRoute> {
  const runtime = getSessionRuntime(input.sessionId);
  const config = loadRoutingConfig();

  const routingRole = agentRoleToRoutingRole(input.role);

  const route = await resolveRoute({
    modelSet: runtime.modelSet,
    role: routingRole,
    difficulty: input.difficulty,
    modelRegistry,
    config,
  });

  return route;
}
