import { readFileSync } from "node:fs";

import {
  compileWorkflowMarkdown,
  type WorkflowMarkdownBindings,
} from "../../adapters/workflow/markdown.ts";
import type { AnyDefinition, WorkflowDefinition } from "../../domain/definition/definition.ts";
import { agentDefinitions } from "../agents.ts";
import { resolveDefinitionSchema } from "../schema-registry.ts";

const referencedDefinitions = new Map<string, AnyDefinition>(
  agentDefinitions.map((definition) => [definition.id, definition] as const),
);

const bindings: WorkflowMarkdownBindings = {
  resolveSchema: resolveDefinitionSchema,
  resolveDefinition(id) {
    const definition = referencedDefinitions.get(id);
    if (!definition) throw new Error(`Unknown workflow state definition ${id}`);
    return definition;
  },
};

function source(name: string): string {
  return readFileSync(new URL(`./sources/${name}.workflow.md`, import.meta.url), "utf8");
}

function register(name: string): WorkflowDefinition<unknown, unknown> {
  const definition = compileWorkflowMarkdown(source(name), bindings);
  if (referencedDefinitions.has(definition.id)) {
    throw new Error(`Duplicate bundled definition ${definition.id}`);
  }
  referencedDefinitions.set(definition.id, definition);
  return definition;
}

// Registration order is dependency order. A later workflow may invoke any agent
// or workflow already registered through its public input/output contract.
export const implementationWorkflow = register("implement");
export const qaWorkflow = register("qa");

export const workflowDefinitions = [implementationWorkflow, qaWorkflow] as const;
