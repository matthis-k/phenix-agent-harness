import { Type } from "typebox";

import type {
  AttentionRoutingDecision,
  AttentionRoutingRequest,
} from "../domain/attention/model.ts";
import { defineSchema } from "../domain/definition/schema.ts";

const runStateSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("completing"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("orphaned"),
]);

export const AttentionRoutingRequestSchema = defineSchema<AttentionRoutingRequest>(
  "attention.routing-request",
  Type.Object({
    message: Type.String({ minLength: 1, maxLength: 4_000 }),
    candidates: Type.Array(
      Type.Object({
        runId: Type.String({ minLength: 1, maxLength: 160 }),
        parentRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        definitionId: Type.String({ minLength: 1, maxLength: 160 }),
        state: runStateSchema,
        objective: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
        activity: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
        activeChildRunIds: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
          maxItems: 32,
        }),
        mutationCapable: Type.Boolean(),
      }),
      { minItems: 1, maxItems: 32 },
    ),
  }),
);

export const AttentionRoutingDecisionSchema = defineSchema<AttentionRoutingDecision>(
  "attention.routing-decision",
  Type.Object({
    targets: Type.Array(
      Type.Object({
        runId: Type.String({ minLength: 1, maxLength: 160 }),
        delivery: Type.Union([Type.Literal("urgent"), Type.Literal("next_turn")]),
        reason: Type.String({ minLength: 1, maxLength: 240 }),
      }),
      { maxItems: 8 },
    ),
    reason: Type.String({ minLength: 1, maxLength: 320 }),
  }),
);
