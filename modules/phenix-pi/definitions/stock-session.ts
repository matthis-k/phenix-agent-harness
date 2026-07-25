import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";

export const STOCK_SESSION_PROMPT_SENTINEL = "PHENIX_STOCK_SESSION";

export interface StockSessionRequest {
  readonly task: string;
  readonly context?: unknown;
  readonly outputSchema: string;
  readonly outputContract: unknown;
}

export interface StockSessionHandoff {
  readonly outputSchema: string;
  readonly value: unknown;
}

export const StockSessionRequestSchema = defineSchema<StockSessionRequest>(
  "request.stock-session.v1",
  Type.Object(
    {
      task: Type.String({ minLength: 1, maxLength: 40_000 }),
      context: Type.Optional(Type.Unknown()),
      outputSchema: Type.String({ minLength: 1, maxLength: 160 }),
      outputContract: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
);

export const StockSessionHandoffSchema = defineSchema<StockSessionHandoff>(
  "outcome.stock-session-handoff.v1",
  Type.Object(
    {
      outputSchema: Type.String({ minLength: 1, maxLength: 160 }),
      value: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
);
