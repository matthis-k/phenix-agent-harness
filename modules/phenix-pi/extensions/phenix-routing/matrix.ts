import { defaultAgentRoutes } from "./default-routing.ts";
import type { Difficulty, RoleRoute, RoutingRole } from "./types.ts";
import { capabilityFromId, ROUTING_ROLES, routingRoleFromId } from "./types.ts";

const DIFFICULTIES = ["D0", "D1", "D2", "D3"] as const satisfies readonly Difficulty[];

type MutableRoleMatrix = Partial<Record<RoutingRole, Partial<Record<Difficulty, RoleRoute>>>>;

/**
 * Project passive agent-route declarations into the resolver's indexed matrix.
 *
 * `defaultAgentRoutes` is the source of truth. This module owns only the lookup
 * representation required by the routing mechanism.
 */
function buildRoleMatrix(): Readonly<Record<RoutingRole, Readonly<Record<Difficulty, RoleRoute>>>> {
  const projected: MutableRoleMatrix = {};

  for (const definition of defaultAgentRoutes) {
    const role = routingRoleFromId(definition.agentClient.id);
    if (projected[role]) {
      throw new Error(`Duplicate routing declaration for role "${role}"`);
    }

    const difficulties: Partial<Record<Difficulty, RoleRoute>> = {};
    for (const difficulty of DIFFICULTIES) {
      const route = definition.difficulties[difficulty];
      difficulties[difficulty] = {
        capability: capabilityFromId(route.capability.id),
        thinking: route.thinking,
      };
    }
    projected[role] = difficulties;
  }

  for (const role of ROUTING_ROLES) {
    const routes = projected[role];
    if (!routes) {
      throw new Error(`Missing routing declaration for role "${role}"`);
    }
    for (const difficulty of DIFFICULTIES) {
      if (!routes[difficulty]) {
        throw new Error(`Missing routing declaration for ${role}/${difficulty}`);
      }
    }
  }

  return projected as Record<RoutingRole, Readonly<Record<Difficulty, RoleRoute>>>;
}

/** Indexed runtime projection of the authoritative agent-route declarations. */
export const ROLE_MATRIX = buildRoleMatrix();

/** List every declared `(role, difficulty)` route. */
export function allMatrixKeys(): Array<{ role: RoutingRole; difficulty: Difficulty }> {
  return ROUTING_ROLES.flatMap((role) => DIFFICULTIES.map((difficulty) => ({ role, difficulty })));
}

/** Assert that the projected matrix remains complete. */
export function validateMatrix(): void {
  for (const { role, difficulty } of allMatrixKeys()) {
    const route = ROLE_MATRIX[role][difficulty];
    if (!route.capability || !route.thinking) {
      throw new Error(`Matrix entry ${role}/${difficulty} is incomplete`);
    }
  }
}
