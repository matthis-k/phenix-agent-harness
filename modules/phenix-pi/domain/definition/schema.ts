import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import type { ValidationResult } from "../shared.ts";

export interface Schema<T> {
  readonly id: string;
  readonly jsonSchema: TSchema;
  validate(value: unknown): ValidationResult<T>;
}

export function defineSchema<T>(id: string, jsonSchema: TSchema): Schema<T> {
  return Object.freeze({
    id,
    jsonSchema,
    validate(value: unknown): ValidationResult<T> {
      if (Check(jsonSchema, value)) return { ok: true, value: value as T };
      const errors = Errors(jsonSchema, value);
      return {
        ok: false,
        issues: errors.map((error) => ({
          path: error.instancePath || "/",
          message: error.message,
        })),
      };
    },
  });
}
