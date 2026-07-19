import "./default-config.ts";

export * from "../../packages/phenix-routing/config.ts";

import { buildRoutingConfigFromDeclarations } from "../../packages/phenix-routing/config.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "../../packages/phenix-suite/defaults/routing.ts";

export function buildBundledConfig() {
  return buildRoutingConfigFromDeclarations({
    routing: {
      modelSets: defaultModelSets,
      pools: defaultModelPools,
      agentRoutes: defaultAgentRoutes,
    },
    defaultModelSet: "mixed",
    modelSetOrder: defaultModelSets.map((modelSet) => modelSet.id),
  });
}
