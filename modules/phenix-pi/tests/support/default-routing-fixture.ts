/** Test-only projection of suite declarations through the generic routing interfaces. */

import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";
import {
  buildRoutingConfigFromDeclarations,
  configureRoutingConfig,
} from "@matthis-k/phenix-routing/config.ts";
import { buildRoleMatrixFromDeclarations } from "@matthis-k/phenix-routing/matrix.ts";
import type { ModelSetId } from "@matthis-k/phenix-routing/types.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "@matthis-k/phenix-suite/defaults/routing.ts";

export function buildDefaultRoutingConfig() {
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

export function configureDefaultRouting(): void {
  configureRoutingConfig(buildDefaultRoutingConfig());
}

export const DEFAULT_MODEL_SET_IDS: readonly ModelSetId[] = defaultModelSets.map((definition) =>
  modelSetId(definition.id),
);

export const DEFAULT_PHENIX_MODEL_SETS = DEFAULT_MODEL_SET_IDS;

export function defaultModelSetForModelId(modelId: string): ModelSetId | undefined {
  return DEFAULT_MODEL_SET_IDS.find((id) => id === modelId);
}

export const DEFAULT_ROLE_MATRIX = buildRoleMatrixFromDeclarations(defaultAgentRoutes);

export function allDefaultMatrixKeys() {
  return Object.keys(DEFAULT_ROLE_MATRIX).flatMap((role) =>
    (["D0", "D1", "D2", "D3"] as const).map((difficulty) => ({ role, difficulty })),
  );
}

export function validateDefaultMatrix(): void {
  for (const { role, difficulty } of allDefaultMatrixKeys()) {
    const route = DEFAULT_ROLE_MATRIX[role]?.[difficulty];
    if (!route?.capability || !route.thinking) {
      throw new Error(`Matrix entry ${role}/${difficulty} is incomplete`);
    }
  }
}

configureDefaultRouting();
