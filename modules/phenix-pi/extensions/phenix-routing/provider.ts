import "./default-config.ts";

export * from "../../packages/phenix-routing/provider.ts";

import type { ModelSetId } from "../../packages/phenix-routing/types.ts";
import { defaultModelSets } from "../../packages/phenix-suite/defaults/routing.ts";

export const PHENIX_MODEL_SETS = defaultModelSets.map((modelSet) => modelSet.id as ModelSetId);

export function modelSetForModelId(modelId: string): ModelSetId | undefined {
  return PHENIX_MODEL_SETS.find((id) => modelId === id);
}
