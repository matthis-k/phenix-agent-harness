import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { compileWorkflowMarkdown } from "../adapters/workflow/markdown.ts";
import { compileWorkflowMarkdownScenarios } from "../adapters/workflow/scenario-markdown.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import type { AnyDefinition } from "../domain/definition/definition.ts";
import { runWorkflowScenario } from "./support/workflow-scenario.ts";

const sourceDirectory = new URL("../definitions/workflows/sources/", import.meta.url);
const definitionById = new Map<string, AnyDefinition>(
  [...agentDefinitions, ...workflowDefinitions].map((definition) => [definition.id, definition]),
);
const bindings = {
  resolveSchema: resolveDefinitionSchema,
  resolveDefinition(id: string): AnyDefinition {
    const definition = definitionById.get(id);
    if (!definition) throw new Error(`Unknown definition ${id}`);
    return definition;
  },
};

for (const fileName of readdirSync(sourceDirectory)
  .filter((name) => name.endsWith(".workflow.md"))
  .sort()) {
  const source = readFileSync(new URL(fileName, sourceDirectory), "utf8");
  const workflow = compileWorkflowMarkdown(source, bindings);
  const scenarios = compileWorkflowMarkdownScenarios(source, bindings);

  test(`${workflow.id} declares executable Markdown scenarios`, () => {
    assert.ok(scenarios.length > 0, `${workflow.id} must declare at least one ## Tests scenario`);
  });
  for (const scenario of scenarios) {
    test(`${workflow.id} / ${scenario.id}`, async () => {
      await runWorkflowScenario(workflow, scenario);
    });
  }
}
