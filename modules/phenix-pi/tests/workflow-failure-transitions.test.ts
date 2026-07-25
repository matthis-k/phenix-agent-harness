import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compileWorkflowMarkdown,
  type WorkflowMarkdownBindings,
} from "../adapters/workflow/markdown.ts";
import { compileWorkflowMarkdownScenarios } from "../adapters/workflow/scenario-markdown.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import type { AnyDefinition } from "../domain/definition/definition.ts";
import { runWorkflowScenario } from "./support/workflow-scenario.ts";

const definitions = new Map<string, AnyDefinition>(
  agentDefinitions.map((definition) => [definition.id, definition]),
);
const bindings: WorkflowMarkdownBindings = {
  resolveSchema: resolveDefinitionSchema,
  resolveDefinition(id) {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`Unknown definition ${id}`);
    return definition;
  },
};
const source = readFileSync(
  new URL("./fixtures/failure-retry.workflow.md", import.meta.url),
  "utf8",
);
const workflow = compileWorkflowMarkdown(source, bindings);
const scenarios = compileWorkflowMarkdownScenarios(source, bindings);

test("failure retry fixture compiles an activation-scoped retry policy", () => {
  const implement = workflow.graph.nodes.find((node) => node.id === "implement");
  assert.equal(implement?.kind, "invoke");
  if (implement?.kind !== "invoke") return;
  assert.deepEqual(implement.retry, { when: "retryable", maxRetries: 1 });
  assert.deepEqual(
    workflow.graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      on: edge.on ?? "success",
      maxTraversals: edge.maxTraversals,
    })),
    [
      {
        from: "implement",
        to: "verify",
        on: "success",
        maxTraversals: undefined,
      },
      {
        from: "verify",
        to: "return",
        on: "success",
        maxTraversals: undefined,
      },
    ],
  );
});

for (const scenario of scenarios) {
  test(`failure retry / ${scenario.id}`, async () => {
    const result = await runWorkflowScenario(workflow, scenario, [workflow]);
    if (scenario.id === "retry-exhausted") {
      assert.equal(result.outcome.status, "failure");
      if (result.outcome.status === "failure") {
        assert.equal(result.outcome.failure.retryable, false);
      }
    }
  });
}
