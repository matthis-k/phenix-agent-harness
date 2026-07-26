import { readdirSync, readFileSync } from "node:fs";

import { compileAgentMarkdown } from "../adapters/agent/markdown.ts";
import {
  compileWorkflowMarkdown,
  parseWorkflowMarkdown,
  type WorkflowMarkdownBindings,
} from "../adapters/workflow/markdown.ts";
import {
  BUNDLED_AGENT_SOURCE_NAMES,
  type BundledAgentSourceName,
} from "../definitions/agents/index.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import type {
  AgentDefinition,
  AnyDefinition,
  WorkflowDefinition,
} from "../domain/definition/definition.ts";

interface WorkflowSource {
  readonly fileName: string;
  readonly source: string;
  readonly id: string;
  readonly invokedDefinitions: readonly string[];
}

const workflowSourceDirectory = new URL("../definitions/workflows/sources/", import.meta.url);

function readAgentSource(name: BundledAgentSourceName): string {
  return readFileSync(
    new URL(`../definitions/agents/sources/${name}.agent.md`, import.meta.url),
    "utf8",
  );
}

function readWorkflowSources(): readonly WorkflowSource[] {
  return readdirSync(workflowSourceDirectory)
    .filter((fileName) => fileName.endsWith(".workflow.md"))
    .sort()
    .map((fileName) => {
      const source = readFileSync(new URL(fileName, workflowSourceDirectory), "utf8");
      const authored = parseWorkflowMarkdown(source);
      const id = authored.fields.id?.trim();
      if (!id) throw new Error(`Workflow source ${fileName} does not declare an id`);
      const invokedDefinitions = [
        ...new Set(
          authored.states.flatMap((state) =>
            state.fields.kind === "invoke" && state.fields.run ? [state.fields.run] : [],
          ),
        ),
      ];
      return { fileName, source, id, invokedDefinitions };
    });
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

function orderWorkflowSources(sources: readonly WorkflowSource[]): readonly WorkflowSource[] {
  const byId = new Map<string, WorkflowSource>();
  for (const source of sources) {
    if (byId.has(source.id) || definitionsById.has(source.id)) {
      throw new Error(`Duplicate bundled definition ${source.id}`);
    }
    byId.set(source.id, source);
  }

  const dependencies = new Map<string, readonly string[]>();
  for (const source of sources) {
    const workflowDependencies: string[] = [];
    for (const invokedId of source.invokedDefinitions) {
      if (byId.has(invokedId)) {
        workflowDependencies.push(invokedId);
      } else if (!definitionsById.has(invokedId)) {
        throw new Error(
          `Workflow source ${source.fileName} references unknown definition ${invokedId}`,
        );
      }
    }
    dependencies.set(source.id, workflowDependencies);
  }

  const remaining = new Map(byId);
  const ordered: WorkflowSource[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((source) =>
        (dependencies.get(source.id) ?? []).every((dependency) => !remaining.has(dependency)),
      )
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
    if (ready.length === 0) {
      throw new Error(`Workflow dependency cycle: ${[...remaining.keys()].sort().join(", ")}`);
    }
    for (const source of ready) {
      remaining.delete(source.id);
      ordered.push(source);
    }
  }
  return ordered;
}

function registerWorkflow(source: WorkflowSource): WorkflowDefinition<unknown, unknown> {
  const definition = compileWorkflowMarkdown(source.source, workflowBindings);
  if (definition.id !== source.id) {
    throw new Error(`Workflow source ${source.fileName} changed id while compiling`);
  }
  definitionsById.set(definition.id, definition);
  return definition;
}

export const workflowDefinitions = orderWorkflowSources(readWorkflowSources()).map(
  registerWorkflow,
);

function requireAgent(id: string): AgentDefinition<unknown, unknown> {
  const definition = definitionsById.get(id);
  if (definition?.kind !== "agent") throw new Error(`Missing bundled agent ${id}`);
  return definition;
}

function requireWorkflow(id: string): WorkflowDefinition<unknown, unknown> {
  const definition = definitionsById.get(id);
  if (definition?.kind !== "workflow") {
    throw new Error(`Missing bundled workflow ${id}`);
  }
  return definition;
}

export const difficultyEstimatorDefinition = requireAgent("agent.difficulty-estimator");
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
export const stockSessionDefinition = requireAgent("session.stock");
export const qaSynthesizerDefinition = requireAgent("agent.qa-synthesizer");
export const attentionRouterDefinition = requireAgent("agent.attention-router");

export const implementationWorkflow = requireWorkflow("workflow.implement");
export const qaWorkflow = requireWorkflow("workflow.qa");
