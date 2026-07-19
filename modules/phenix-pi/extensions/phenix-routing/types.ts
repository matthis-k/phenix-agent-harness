import "./default-config.ts";

export * from "../../packages/phenix-routing/types.ts";

import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";
import { defaultModelSets } from "../../packages/phenix-suite/defaults/routing.ts";

export const MODEL_SET_IDS = defaultModelSets.map((definition) => modelSetId(definition.id));
