import type { WorkflowDefinition } from "./workflow-types.ts";

const definitions = new Map<string, WorkflowDefinition>();

export function defineWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  const errors = validateDefinition(definition);
  if (errors.length > 0) {
    throw new Error(`Invalid workflow definition "${definition.id}": ${errors.join("; ")}`);
  }
  return definition;
}

export function registerWorkflowDefinition(definition: WorkflowDefinition): void {
  const normalized = defineWorkflow(definition);
  definitions.set(normalized.id, normalized);
}

export function registerWorkflowDefinitions(items: readonly WorkflowDefinition[]): void {
  for (const definition of items) registerWorkflowDefinition(definition);
}

export function clearWorkflowDefinitions(): void {
  definitions.clear();
}

export function getWorkflowDefinition(id: string): WorkflowDefinition | undefined {
  return definitions.get(id);
}

export function requireWorkflowDefinition(id: string): WorkflowDefinition {
  const definition = getWorkflowDefinition(id);
  if (!definition) throw new Error(`Unknown workflow definition: ${id}`);
  return definition;
}

export function validateDefinition(def: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  if (!def.id || def.id.trim().length === 0) errors.push("Workflow definition ID is empty");
  if (!def.initialState || def.initialState.trim().length === 0) {
    errors.push("Workflow initial state is empty");
  }

  for (const transition of def.transitions) {
    if (seenIds.has(transition.id)) {
      errors.push(`Duplicate transition ID: ${transition.id}`);
    }
    seenIds.add(transition.id);
  }

  return errors;
}
