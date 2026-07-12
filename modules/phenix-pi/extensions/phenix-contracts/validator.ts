/**
 * phenix-contracts — canonical schema compiler and validator
 *
 * All static and runtime handoff validation goes through this module. Schema
 * limits are enforced before compilation so model-provided schemas cannot
 * trigger unbounded traversal or remote reference resolution.
 */

import { Compile } from "typebox/compile";

import type {
  ContractDefinition,
  ContractValidationIssue,
  ContractValidationResult,
  JsonSchema,
  SchemaValidation,
  SchemaViolation,
} from "./definitions.ts";

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_NODES = 1024;
const MAX_REPORTED_ISSUES = 12;

interface CompiledSchema {
  Check(value: unknown): boolean;
  Errors(value: unknown): Iterable<{
    instancePath?: string;
    path?: string;
    message?: string;
  }>;
}

function compileSchema(schema: JsonSchema): CompiledSchema {
  return (Compile as (input: unknown) => CompiledSchema)(schema);
}

function visitSchema(value: unknown, depth: number, state: { nodes: number }): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error(`output schema exceeds maximum depth ${MAX_SCHEMA_DEPTH}`);
  }
  if (!value || typeof value !== "object") return;

  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) {
    throw new Error(`output schema exceeds maximum node count ${MAX_SCHEMA_NODES}`);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitSchema(item, depth + 1, state);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && !child.startsWith("#")) {
      throw new Error("remote output-schema $ref values are not allowed");
    }
    visitSchema(child, depth + 1, state);
  }
}

/**
 * Validate schema structure, resource limits, and TypeBox compatibility.
 */
export function assertJsonSchema(value: unknown): asserts value is JsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("outputSchema must be a JSON Schema object");
  }

  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf-8") > MAX_SCHEMA_BYTES) {
    throw new Error(`output schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }

  visitSchema(value, 0, { nodes: 0 });

  try {
    compileSchema(value);
  } catch (error) {
    throw new Error(
      `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Backward-compatible runtime name retained at schema-input boundaries. */
export const assertOutputSchema = assertJsonSchema;

function stringPath(error: { instancePath?: string; path?: string }): string {
  return (error.instancePath ?? error.path ?? "").replace(/^\//, "").replaceAll("/", ".") || "root";
}

function pathSegments(path: string): readonly (string | number)[] {
  if (path === "root" || path.length === 0) return [];

  return path.split(".").map((segment) => {
    const index = Number(segment);
    return Number.isInteger(index) && String(index) === segment ? index : segment;
  });
}

function validationFailure(
  compiled: CompiledSchema,
  value: unknown,
): Extract<SchemaValidation, { readonly ok: false }> {
  const violations: SchemaViolation[] = [...compiled.Errors(value)]
    .slice(0, MAX_REPORTED_ISSUES)
    .map((error) => ({
      path: stringPath(error),
      message: error.message ?? "schema validation failed",
    }));

  return {
    ok: false,
    summary:
      violations.map((entry) => `${entry.path}: ${entry.message}`).join("; ") ||
      "schema validation failed",
    violations,
  };
}

/** Validate a runtime value directly against a JSON Schema. */
export function validateSchema(schema: JsonSchema, value: unknown): SchemaValidation {
  let compiled: CompiledSchema;
  try {
    assertJsonSchema(schema);
    compiled = compileSchema(schema);
  } catch (error) {
    return {
      ok: false,
      summary: `invalid runtime output contract: ${
        error instanceof Error ? error.message : String(error)
      }`,
      violations: [],
    };
  }

  return compiled.Check(value) ? { ok: true } : validationFailure(compiled, value);
}

/** Validate a value against a reusable static contract definition. */
export function validateContract<T>(
  definition: ContractDefinition<T>,
  value: unknown,
): ContractValidationResult<T> {
  const validation = validateSchema(definition.schema, value);
  if (validation.ok) {
    return { ok: true, value: value as T };
  }

  const issues: ContractValidationIssue[] = validation.violations.map((violation) => ({
    path: pathSegments(violation.path),
    message: violation.message,
  }));
  return {
    ok: false,
    issues,
    summary: validation.summary,
  };
}
