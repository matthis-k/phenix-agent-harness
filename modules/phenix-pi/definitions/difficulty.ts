import { Type } from "typebox";

import type { Difficulty } from "../domain/definition/model.ts";
import { defineSchema } from "../domain/definition/schema.ts";
import type { ObjectiveRequest } from "./schemas.ts";

export type DifficultyAssessmentRequest = ObjectiveRequest;

export interface DifficultyAssessment {
  readonly difficulty: Difficulty;
  readonly summary: string;
  readonly signals: readonly string[];
}

export const DifficultyAssessmentRequestSchema = defineSchema<DifficultyAssessmentRequest>(
  "request.difficulty-assessment",
  Type.Object({
    objective: Type.String({ minLength: 1 }),
    context: Type.Optional(Type.Unknown()),
  }),
);

export const DifficultyAssessmentSchema = defineSchema<DifficultyAssessment>(
  "outcome.difficulty-assessment",
  Type.Object({
    difficulty: Type.Enum(["D0", "D1", "D2", "D3"]),
    summary: Type.String({ minLength: 1 }),
    signals: Type.Array(Type.String()),
  }),
);
