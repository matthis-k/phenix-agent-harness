import {
  buildRoutingConfigFromDeclarations,
  configureRoutingConfig,
} from "../../packages/phenix-routing/config.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "../../packages/phenix-suite/defaults/routing.ts";

export function configureLegacyPhenixRoutingDefaults(): void {
  configureRoutingConfig(
    buildRoutingConfigFromDeclarations({
      routing: {
        modelSets: defaultModelSets,
        pools: defaultModelPools,
        agentRoutes: defaultAgentRoutes,
      },
      defaultModelSet: "mixed",
      modelSetOrder: defaultModelSets.map((modelSet) => modelSet.id),
    }),
  );
}

configureLegacyPhenixRoutingDefaults();
