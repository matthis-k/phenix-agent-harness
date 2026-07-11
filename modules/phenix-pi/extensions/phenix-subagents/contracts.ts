import { Compile } from "typebox/compile";

export type JsonSchema = Record<string, unknown>;

export interface ContractViolation {
  readonly path: string;
  readonly message: string;
}

export type ContractValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly violations: readonly ContractViolation[];
    };

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_NODES = 1024;

interface CompiledSchema {
  Check(value: unknown): boolean;
  Errors(value: unknown): Iterable<{
    instancePath?: string;
    path?: string;
    message?: string;
  }>;
}

function visitSchema(
  value: unknown,
  depth: number,
  state: { nodes: number },
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error(`output schema exceeds maximum depth ${MAX_SCHEMA_DEPTH}`);
  }
  if (!value || typeof value !== "object") return;

  state.nodes++;
  if (state.nodes > MAX_SCHEMA_NODES) {
    throw new Error(`output schema exceeds maximum node count ${MAX_SCHEMA_NODES}`);
  }

  if (Array.isArray(value)) {
    for (const item of value) visitSchema(item, depth + 1, state);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && !child.startsWith("#")) {
      throw new Error("remote output-schema $ref values are not allowed");
    }
    visitSchema(child, depth + 1, state);
  }
}

export function assertOutputSchema(value: unknown): asserts value is JsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("outputSchema must be a JSON Schema object");
  }

  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf-8") > MAX_SCHEMA_BYTES) {
    throw new Error(`output schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }

  visitSchema(value, 0, { nodes: 0 });

  try {
    (Compile as (schema: unknown) => CompiledSchema)(value);
  } catch (error) {
    throw new Error(
      `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateContract(
  schema: JsonSchema,
  value: unknown,
): ContractValidation {
  let compiled: CompiledSchema;
  try {
    compiled = (Compile as (schema: unknown) => CompiledSchema)(schema);
  } catch (error) {
    return {
      ok: false,
      summary: `invalid runtime output contract: ${
        error instanceof Error ? error.message : String(error)
      }`,
      violations: [],
    };
  }

  if (compiled.Check(value)) return { ok: true };

  const violations = [...compiled.Errors(value)].slice(0, 12).map((error) => ({
    path:
      (error.instancePath ?? error.path ?? "")
        .replace(/^\//, "")
        .replaceAll("/", ".") || "root",
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
