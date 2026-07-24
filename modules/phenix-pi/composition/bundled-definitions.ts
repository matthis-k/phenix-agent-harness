import { readFileSync } from "node:fs";

import { compileAgentMarkdown } from "../adapters/agent/markdown.ts";
import {
  compileWorkflowMarkdown,
  type WorkflowMarkdownBindings,
} from "../adapters/workflow/markdown.ts";
import {
  BUNDLED_AGENT_SOURCE_NAMES,
  type BundledAgentSourceName,
} from "../definitions/agents/index.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import {
  BUNDLED_WORKFLOW_SOURCE_NAMES,
  type BundledWorkflowSourceName,
} from "../definitions/workflows/manifest.ts";
import type {
  AgentDefinition,
  AnyDefinition,
  WorkflowDefinition,
} from "../domain/definition/definition.ts";

function readAgentSource(name: BundledAgentSourceName): string {
  return readFileSync(
    new URL(`../definitions/agents/sources/${name}.agent.md`, import.meta.url),
    "utf8",
  );
}

function readWorkflowSource(name: BundledWorkflowSourceName): string {
  return readFileSync(
    new URL(`../definitions/workflows/sources/${name}.workflow.md`, import.meta.url),
    "utf8",
  );
}

export const agentDefinitions = BUNDLED_AGENT_SOURCE_NAMES.map((name) =>
  compileAgentMarkdown(readAgentSource(name), { resolveSchema: resolveDefinitionSchema }),
);

const definitionsById = new Map<string, AnyDefinition>(
  agentDefinitions.map((definition) => [definition.id, definition] as const),
);

const workflowBindings: WorkflowMarkdownBindings = {
  resolveSchema: resolveDefinitionSchema,
  resolveDefinition(id) {
    const definition = definitionsById.get(id);
    if (!definition) throw new Error(`Unknown workflow state definition ${id}`);
    return definition;
  },
};

function registerWorkflow(name: BundledWorkflowSourceName): WorkflowDefinition<unknown, unknown> {
  const definition = compileWorkflowMarkdown(readWorkflowSource(name), workflowBindings);
  if (definitionsById.has(definition.id)) {
    throw new Error(`Duplicate bundled definition ${definition.id}`);
  }
  definitionsById.set(definition.id, definition);
  return definition;
}

// The manifest order is dependency order. A workflow may invoke any agent or
// earlier workflow through its public input/output contract.
export const workflowDefinitions = BUNDLED_WORKFLOW_SOURCE_NAMES.map(registerWorkflow);

function requireAgent(id: string): AgentDefinition<unknown, unknown> {
  const definition = definitionsById.get(id);
  if (!definition || definition.kind !== "agent") throw new Error(`Missing bundled agent ${id}`);
  return definition;
}

function requireWorkflow(id: string): WorkflowDefinition<unknown, unknown> {
  const definition = definitionsById.get(id);
  if (!definition || definition.kind !== "workflow") {
    throw new Error(`Missing bundled workflow ${id}`);
  }
  return definition;
}

export const scoutDefinition = requireAgent("agent.scout");
export const plannerDefinition = requireAgent("agent.planner");
export const architectDefinition = requireAgent("agent.architect");
export const implementerDefinition = requireAgent("agent.implementer");
export const testerDefinition = requireAgent("agent.tester");
export const verifierDefinition = requireAgent("agent.verifier");
export const criticDefinition = requireAgent("agent.critic");
export const finalizerDefinition = requireAgent("agent.finalizer");
export const dispatcherDefinition = requireAgent("agent.dispatcher");
export const coordinatorDefinition = requireAgent("agent.coordinator");
export const baseDefinition = requireAgent("agent.base");
export const qaSynthesizerDefinition = requireAgent("agent.qa-synthesizer");

export const implementationWorkflow = requireWorkflow("workflow.implement");
export const qaWorkflow = requireWorkflow("workflow.qa");
