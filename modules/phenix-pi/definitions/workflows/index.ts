import { readFileSync } from "node:fs";

import {
  compileWorkflowMarkdown,
  type WorkflowMarkdownBindings,
} from "../../adapters/workflow/markdown.ts";
import type { AnyDefinition, WorkflowDefinition } from "../../domain/definition/definition.ts";
import { agentDefinitions } from "../agents.ts";
import { resolveDefinitionSchema } from "../schema-registry.ts";

const referencedDefinitions = new Map<string, AnyDefinition>(
  agentDefinitions.map((definition) => [definition.id, definition]),
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

function definition(name: string): WorkflowDefinition<unknown, unknown> {
  return compileWorkflowMarkdown(source(name), bindings);
}

export const implementationWorkflow = definition("implement");
export const qaWorkflow = definition("qa");

export const workflowDefinitions = [implementationWorkflow, qaWorkflow] as const;
