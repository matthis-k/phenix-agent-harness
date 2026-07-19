import type { AgentRouteDefinition } from "./definitions.ts";
import type { Difficulty, RoleRoute, RoutingConfig, RoutingRole } from "./types.ts";
import { capabilityFromId, routingRoleFromId } from "./types.ts";

const DIFFICULTIES = ["D0", "D1", "D2", "D3"] as const satisfies readonly Difficulty[];

type MutableRoleMatrix = Partial<Record<RoutingRole, Partial<Record<Difficulty, RoleRoute>>>>;

/** Project passive agent-route declarations into the resolver's indexed matrix. */
export function buildRoleMatrixFromDeclarations(
  agentRoutes: readonly AgentRouteDefinition[],
): Readonly<Record<RoutingRole, Readonly<Record<Difficulty, RoleRoute>>>> {
  const projected: MutableRoleMatrix = {};

  for (const definition of agentRoutes) {
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

  return projected as Record<RoutingRole, Readonly<Record<Difficulty, RoleRoute>>>;
}

export function roleMatrixFromConfig(
  config: RoutingConfig,
): Readonly<Record<string, Readonly<Record<Difficulty, RoleRoute>>>> {
  return config.roleRoutes ?? {};
}

/** List every declared `(role, difficulty)` route in a config. */
export function allMatrixKeys(
  config: RoutingConfig,
): Array<{ role: string; difficulty: Difficulty }> {
  return Object.keys(roleMatrixFromConfig(config)).flatMap((role) =>
    DIFFICULTIES.map((difficulty) => ({ role, difficulty })),
  );
}

/** Assert that the projected matrix remains complete. */
export function validateMatrix(config: RoutingConfig): void {
  const matrix = roleMatrixFromConfig(config);
  for (const { role, difficulty } of allMatrixKeys(config)) {
    const route = matrix[role]?.[difficulty];
    if (!route?.capability || !route.thinking) {
      throw new Error(`Matrix entry ${role}/${difficulty} is incomplete`);
    }
  }
}
