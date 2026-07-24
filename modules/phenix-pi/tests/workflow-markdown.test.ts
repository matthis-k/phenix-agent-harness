import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compileWorkflowMarkdown,
  parseWorkflowMarkdown,
  type WorkflowMarkdownBindings,
} from "../adapters/workflow/markdown.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import { implementationWorkflow, qaWorkflow } from "../definitions/workflows/index.ts";
import type { AnyDefinition } from "../domain/definition/definition.ts";

const definitionById = new Map<string, AnyDefinition>(
  [...agentDefinitions, implementationWorkflow, qaWorkflow].map(
    (definition) => [definition.id, definition] as const,
  ),
);

const bindings: WorkflowMarkdownBindings = {
  resolveSchema: resolveDefinitionSchema,
  resolveDefinition(id) {
    const definition = definitionById.get(id);
    if (!definition) throw new Error(`Unknown definition ${id}`);
    return definition;
  },
};

function source(name: string): string {
  return readFileSync(
    new URL(`../definitions/workflows/sources/${name}.workflow.md`, import.meta.url),
    "utf8",
  );
}

test("bundled Markdown workflows are the production definitions", () => {
  assert.deepEqual(compileWorkflowMarkdown(source("qa"), bindings), qaWorkflow);
  assert.deepEqual(compileWorkflowMarkdown(source("implement"), bindings), implementationWorkflow);
});

test("implementation workflow binds routes to its estimator result", () => {
  const compiled = compileWorkflowMarkdown(source("implement"), bindings);
  const invocations = compiled.graph.nodes.filter((node) => node.kind === "invoke");
  const estimate = invocations.find((node) => node.id === "estimate");
  const implement = invocations.find((node) => node.id === "implement");
  const verify = invocations.find((node) => node.id === "verify");
  assert.deepEqual(estimate?.difficulty, { kind: "fixed", value: "D0" });
  assert.deepEqual(implement?.difficulty, { kind: "result", nodeId: "estimate" });
  assert.deepEqual(verify?.difficulty, { kind: "result", nodeId: "estimate" });
  assert.ok(
    compiled.graph.edges.some(
      (edge) =>
        edge.from === "estimate" && edge.to === "implement" && edge.when === "difficulty.D0",
    ),
  );
  assert.ok(
    compiled.graph.edges.some(
      (edge) =>
        edge.from === "estimate" && edge.to === "plan" && edge.when === "difficulty.at-least-D1",
    ),
  );
});

test("QA fixes review difficulty independently of caller routing", () => {
  const compiled = compileWorkflowMarkdown(source("qa"), bindings);
  const invocations = compiled.graph.nodes.filter((node) => node.kind === "invoke");
  assert.deepEqual(invocations.find((node) => node.id === "repo")?.difficulty, {
    kind: "fixed",
    value: "D2",
  });
  assert.deepEqual(invocations.find((node) => node.id === "architecture")?.difficulty, {
    kind: "fixed",
    value: "D3",
  });
  assert.deepEqual(invocations.find((node) => node.id === "security")?.difficulty, {
    kind: "fixed",
    value: "D3",
  });
});

test("workflow states may invoke other workflows through the normal definition boundary", () => {
  const compiled = compileWorkflowMarkdown(source("qa-fix"), bindings);
  const invocations = compiled.graph.nodes.filter((node) => node.kind === "invoke");
  assert.deepEqual(
    invocations.map((node) => node.definition.id),
    ["workflow.qa", "workflow.implement"],
  );
});

test("invoked step contracts must match the referenced definition", () => {
  const invalid = source("implement").replace(
    "output-schema: outcome.plan.v1",
    "output-schema: outcome.change-set.v1",
  );
  assert.throws(
    () => compileWorkflowMarkdown(invalid, bindings),
    /schema outcome.change-set.v1 does not match outcome.plan.v1/,
  );
});

test("result-bound difficulty must reference another state", () => {
  const invalid = source("implement").replace(
    "difficulty: result:estimate",
    "difficulty: result:missing",
  );
  assert.throws(
    () => compileWorkflowMarkdown(invalid, bindings),
    /obtains difficulty from unknown state missing/,
  );
});

test("state Prompt sections are parsed but rejected until typed binding is implemented", () => {
  const withPrompt = source("qa-fix").replace(
    "wait: await\n```\n\n### route",
    "wait: await\n```\n\n#### Prompt\n\nRun QA for {{ input.objective }}.\n\n### route",
  );
  const authored = parseWorkflowMarkdown(withPrompt);
  assert.equal(authored.states[0]?.prompt, "Run QA for {{ input.objective }}.");
  assert.throws(
    () => compileWorkflowMarkdown(withPrompt, bindings),
    /executable state prompts are not bound yet/,
  );
});
