import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Schema } from "../domain/definition/schema.ts";
import {
  compileWorkflowMarkdown,
  parseWorkflowMarkdown,
  type WorkflowMarkdownBindings,
} from "../domain/workflow/markdown.ts";
import {
  FinalReportSchema,
  ImplementationRequestSchema,
  ImplementationResultSchema,
  ObjectiveRequestSchema,
  QAReportSchema,
} from "../definitions/schemas.ts";
import {
  implementationWorkflow,
  qaWorkflow,
} from "../definitions/workflows/index.ts";

const schemaById = new Map<string, Schema<unknown>>(
  [
    ObjectiveRequestSchema,
    QAReportSchema,
    ImplementationRequestSchema,
    ImplementationResultSchema,
    FinalReportSchema,
  ].map((schema) => [schema.id, schema as Schema<unknown>]),
);

const bindings: WorkflowMarkdownBindings = {
  resolveSchema(id) {
    const schema = schemaById.get(id);
    if (!schema) throw new Error(`Unknown schema ${id}`);
    return schema;
  },
};

function source(name: string): string {
  return readFileSync(
    new URL(`../definitions/workflows/sources/${name}.workflow.md`, import.meta.url),
    "utf8",
  );
}

test("Markdown QA workflow compiles to the current typed definition", () => {
  assert.deepEqual(compileWorkflowMarkdown(source("qa"), bindings), qaWorkflow);
});

test("Markdown implementation workflow compiles to the current typed definition", () => {
  assert.deepEqual(compileWorkflowMarkdown(source("implement"), bindings), implementationWorkflow);
});

test("workflow states may invoke other workflows through the normal definition boundary", () => {
  const compiled = compileWorkflowMarkdown(source("qa-fix"), bindings);
  const invocations = compiled.graph.nodes.filter((node) => node.kind === "invoke");
  assert.deepEqual(
    invocations.map((node) => node.definition.id),
    ["workflow.qa", "workflow.implement"],
  );
});

test("state Prompt sections are parsed but rejected until typed binding is implemented", () => {
  const authored = parseWorkflowMarkdown(`${source("qa-fix").replace(
    "### qa\n",
    "### qa\n\n#### Prompt\n\nRun QA for {{ input.objective }}.\n",
  )}`);
  assert.equal(authored.states[0]?.prompt, "Run QA for {{ input.objective }}.");
  assert.throws(
    () =>
      compileWorkflowMarkdown(
        source("qa-fix").replace(
          "### qa\n",
          "### qa\n\n#### Prompt\n\nRun QA for {{ input.objective }}.\n",
        ),
        bindings,
      ),
    /executable state prompts are not bound yet/,
  );
});
