import "./default-config.ts";

export * from "../../packages/phenix-routing/matrix.ts";

import { buildRoleMatrixFromDeclarations } from "../../packages/phenix-routing/matrix.ts";
import { defaultAgentRoutes } from "../../packages/phenix-suite/defaults/routing.ts";

export const ROLE_MATRIX = buildRoleMatrixFromDeclarations(defaultAgentRoutes);

export function allMatrixKeys() {
  return Object.keys(ROLE_MATRIX).flatMap((role) =>
    (["D0", "D1", "D2", "D3"] as const).map((difficulty) => ({ role, difficulty })),
  );
}

export function validateMatrix(): void {
  for (const { role, difficulty } of allMatrixKeys()) {
    const route = ROLE_MATRIX[role]?.[difficulty];
    if (!route?.capability || !route.thinking) {
      throw new Error(`Matrix entry ${role}/${difficulty} is incomplete`);
    }
  }
}
