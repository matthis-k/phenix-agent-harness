import type { AgentRole } from "../phenix-kernel/agents.ts";
import { loadRoutingConfig } from "./config.ts";
import { modelRegistry } from "./registry.ts";
import { resolveRoute } from "./resolver.ts";
import type {
  Difficulty,
  ModelSetId,
  ResolvedRoute,
  RoutingRole,
} from "./types.ts";

function routingRole(role: AgentRole): RoutingRole {
  return role === null ? "base" : role;
}

export async function resolveChildRoute(input: {
  readonly modelSet: ModelSetId;
  readonly role: AgentRole;
  readonly difficulty: Difficulty;
}): Promise<ResolvedRoute> {
  return resolveRoute({
    modelSet: input.modelSet,
    role: routingRole(input.role),
    difficulty: input.difficulty,
    modelRegistry,
    config: loadRoutingConfig(),
  });
}
