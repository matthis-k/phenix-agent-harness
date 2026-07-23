import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";

export const DISPATCH_ROUTES = ["qa", "implement", "coordinate"] as const;
export type DispatchRoute = (typeof DISPATCH_ROUTES)[number];

export interface DispatchDecision {
  readonly route: DispatchRoute;
  readonly reason: string;
  readonly confidence: number;
}

export const DispatchDecisionSchema = defineSchema<DispatchDecision>(
  "outcome.dispatch-decision.v1",
  Type.Object({
    route: Type.Enum(DISPATCH_ROUTES),
    reason: Type.String({ minLength: 1 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  }),
);
