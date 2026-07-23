import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";
import type { DefinitionId } from "../domain/shared.ts";

export const DISPATCH_ROUTES = ["qa", "implement", "coordinate"] as const;
export type DispatchRoute = (typeof DISPATCH_ROUTES)[number];

export interface DispatchCandidate {
  readonly definitionId: DefinitionId;
  readonly kind: "workflow" | "generic";
  readonly title: string;
  readonly description: string;
}

export interface DispatchSelectionRequest {
  readonly objective: string;
  readonly context?: unknown;
  readonly candidates: readonly DispatchCandidate[];
}

export interface DispatchDecision {
  readonly definitionId: DefinitionId;
  readonly reason: string;
  readonly confidence: number;
}

const DispatchCandidateType = Type.Object({
  definitionId: Type.String({ minLength: 1 }),
  kind: Type.Enum(["workflow", "generic"]),
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
});

export const DispatchSelectionRequestSchema = defineSchema<DispatchSelectionRequest>(
  "request.dispatch-selection.v1",
  Type.Object({
    objective: Type.String({ minLength: 1 }),
    context: Type.Optional(Type.Unknown()),
    candidates: Type.Array(DispatchCandidateType, { minItems: 1 }),
  }),
);

export const DispatchDecisionSchema = defineSchema<DispatchDecision>(
  "outcome.dispatch-decision.v2",
  Type.Object({
    definitionId: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  }),
);
