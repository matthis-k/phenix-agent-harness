import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";
import type { CheckResult } from "./schemas.ts";

export interface QAChecksRequest {
  readonly checks?: readonly unknown[];
}

const CheckResultType = Type.Object({
  command: Type.String(),
  ok: Type.Boolean(),
  summary: Type.String(),
});

export const QAChecksRequestSchema = defineSchema<QAChecksRequest>(
  "request.qa-checks.v1",
  Type.Object({ checks: Type.Optional(Type.Array(Type.Unknown())) }),
);

export const CheckResultsSchema = defineSchema<readonly CheckResult[]>(
  "outcome.check-results.v1",
  Type.Array(CheckResultType),
);
