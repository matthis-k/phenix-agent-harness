import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import type { ValidationResult } from "../shared.ts";

const VERSIONED_SCHEMA_ID = /(?:^|[._-])v\d+(?:$|[._-])/i;

export interface Schema<T> {
  readonly id: string;
  readonly jsonSchema: TSchema;
  validate(value: unknown): ValidationResult<T>;
}

export function defineSchema<T>(id: string, jsonSchema: TSchema): Schema<T> {
  const normalizedId = id.trim();
  if (!normalizedId) throw new Error("Schema ID must not be empty");
  if (VERSIONED_SCHEMA_ID.test(normalizedId)) {
    throw new Error(`Schema IDs must be unversioned: ${normalizedId}`);
  }

  return Object.freeze({
    id: normalizedId,
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
