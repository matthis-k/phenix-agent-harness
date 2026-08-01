import assert from "node:assert/strict";
import test from "node:test";

import { definitionRef, type WorkflowDefinition } from "../domain/definition/definition.ts";
import type { Schema } from "../domain/definition/schema.ts";
import { definitionId } from "../domain/shared.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

const valueSchema: Schema<unknown> = {
  id: "test.workflow-operation-value",
  jsonSchema: {} as Schema<unknown>["jsonSchema"],
  validate: (value: unknown) => ({ ok: true, value }),
};

const workflow: WorkflowDefinition<unknown, unknown> = {
  id: definitionId("workflow.operation-identity-test"),
  kind: "workflow",
  title: "Operation identity test",
  description: "Exercise one deterministic local operation.",
  input: valueSchema,
  output: valueSchema,
  graph: {
    entry: "operation",
    nodes: [
      {
        kind: "local",
        id: "operation",
        operation: "local.identity-test",
        input: "operation-identity.input",
      },
      { kind: "return", id: "return", output: "operation-identity.output" },
    ],
    edges: [{ from: "operation", to: "return" }],
  },
  limits: { timeoutMs: 10_000, maxNodeRuns: 2, maxParallelism: 1 },
};

test("workflow-owned operations receive a stable activation-scoped execution identity", async () => {
  const executions: string[] = [];
  const operations: LocalOperationRunner = {
    has: (operation) => operation === "local.identity-test",
    async run(_operation, input, context) {
      executions.push(context.executionId);
      return input;
    },
  };
  const runtime = await createTestRuntime(undefined, {
    definitions: [workflow],
    operations,
    registerFunctions(functions) {
      functions.registerMapping("operation-identity.input", (context) => context.input);
      functions.registerMapping("operation-identity.output", (context) =>
        context.latest.get("operation"),
      );
    },
  });

  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(workflow.id),
    input: { value: 42 },
    wait: "await",
  });
  assert.equal((await handle.result()).status, "success");
  assert.equal(executions.length, 1);
  assert.match(executions[0] ?? "", new RegExp(`^${handle.id}:activation-[^:]+:operation$`));
});
