/**
 * phenix-contracts — validator
 *
 * Schema-agnostic JSON validation against contract definitions.
 * Uses a built-in JSON Schema validator implementation.
 */

import type {
  ContractDefinition,
  ContractValidationIssue,
  ContractValidationResult,
} from "./definitions.ts";

// ── Validation ─────────────────────────────────────────────────────────────

function validateNode(
  schema: Record<string, unknown>,
  value: unknown,
  path: readonly (string | number)[],
): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];

  const type = schema["type"] as string | undefined;

  if (type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const val = value as Record<string, unknown>;

    // Check required
    const required = schema["required"] as string[] | undefined;
    if (required) {
      for (const key of required) {
        if (!(key in val) || val[key] === undefined) {
          issues.push({
            path: [...path, key],
            message: `Required property "${key}" is missing`,
          });
        }
      }
    }

    // Check additionalProperties
    if (schema["additionalProperties"] === false) {
      const allowedProps = schema["properties"] as Record<string, unknown> | undefined;
      const allowedKeys = allowedProps ? Object.keys(allowedProps) : [];
      for (const key of Object.keys(val)) {
        if (!allowedKeys.includes(key)) {
          issues.push({
            path: [...path, key],
            message: `Unexpected property "${key}" is not allowed`,
          });
        }
      }
    }

    // Check each property
    const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in val && val[key] !== undefined) {
          issues.push(...validateNode(propSchema, val[key], [...path, key]));
        }
      }
    }
  } else if (type === "array" && Array.isArray(value)) {
    const items = schema["items"] as Record<string, unknown> | undefined;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        issues.push(...validateNode(items, value[i], [...path, i]));
      }
    }
  } else if (type === "string") {
    if (typeof value !== "string") {
      issues.push({
        path,
        message: `Expected string but got ${typeof value}`,
      });
    } else {
      const minLength = schema["minLength"] as number | undefined;
      if (minLength !== undefined && value.length < minLength) {
        issues.push({
          path,
          message: `String must have minimum length ${minLength}`,
        });
      }
    }
  } else if (type === "boolean") {
    if (typeof value !== "boolean") {
      issues.push({
        path,
        message: `Expected boolean but got ${typeof value}`,
      });
    }
  } else if (type === "integer" || type === "number") {
    if (typeof value !== "number") {
      issues.push({
        path,
        message: `Expected ${type} but got ${typeof value}`,
      });
    } else {
      const minimum = schema["minimum"] as number | undefined;
      if (minimum !== undefined && value < minimum) {
        issues.push({
          path,
          message: `Value must be >= ${minimum}`,
        });
      }
    }
  } else if (type === "enum") {
    // enum values are specified as an array
    // handled generically - actual enum checks are in the type-specific validators
  }

  // Check enum constraint at any node
  const enumValues = schema["enum"] as unknown[] | undefined;
  if (enumValues && !enumValues.includes(value)) {
    issues.push({
      path,
      message: `Value "${String(value)}" is not one of: ${enumValues.map(String).join(", ")}`,
    });
  }

  return issues;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function validateContract<T = unknown>(
  definition: ContractDefinition<T>,
  value: unknown,
): ContractValidationResult<T> {
  const schema = definition.schema as Record<string, unknown>;
  const issues = validateNode(schema, value, []);
  if (issues.length > 0) {
    const summary = `Contract validation failed with ${issues.length} issue(s):\n${issues
      .map((i) => `  [${i.path.join(".") || "root"}] ${i.message}`)
      .join("\n")}`;
    return {
      ok: false,
      issues,
      summary,
    };
  }

  return {
    ok: true,
    value: value as T,
  };
}
