import type { WorkflowOutputSchemaId } from "./workflow-types.ts";

const schemas = new Map<string, Record<string, unknown>>();

export function registerOutputSchema(id: string, schema: Record<string, unknown>): void {
  if (!id || id.trim().length === 0) throw new Error("Output schema ID must be non-empty");
  schemas.set(id, schema);
}

export function registerOutputSchemas(
  items: Readonly<Record<string, Record<string, unknown>>>,
): void {
  for (const [id, schema] of Object.entries(items)) registerOutputSchema(id, schema);
}

export function clearOutputSchemas(): void {
  schemas.clear();
}

export function isOutputSchemaRegistered(id: WorkflowOutputSchemaId | string): boolean {
  return schemas.has(id);
}

export function getOutputSchema(id: WorkflowOutputSchemaId | string): Record<string, unknown> {
  const schema = schemas.get(id);
  if (!schema) {
    throw new Error(`Unknown output schema ID: ${id}`);
  }
  return schema;
}

export function listOutputSchemas(): Readonly<Record<string, Record<string, unknown>>> {
  return Object.freeze(Object.fromEntries(schemas.entries()));
}
