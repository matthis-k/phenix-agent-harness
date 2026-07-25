import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";

export interface StockSessionRequest {
  readonly task: string;
  readonly context?: unknown;
}

export const StockSessionRequestSchema = defineSchema<StockSessionRequest>(
  "request.stock-session.v1",
  Type.Object(
    {
      task: Type.String({ minLength: 1, maxLength: 40_000 }),
      context: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
  ),
);

/** Catalog placeholder only. Every stock-session invocation binds a concrete output schema. */
export const StockSessionDynamicOutputSchema = defineSchema<unknown>(
  "outcome.stock-session.dynamic",
  Type.Unknown(),
);
