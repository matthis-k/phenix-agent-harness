import assert from "node:assert/strict";
import test from "node:test";

import {
  compileWorkflowMarkdown,
  type WorkflowMarkdownBindings,
} from "../adapters/workflow/markdown.ts";
import { WORKFLOW_IMPLEMENT } from "../definitions/ids.ts";
import {
  ImplementationRequestSchema,
  type ImplementationResult,
  ImplementationResultSchema,
} from "../definitions/schemas.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { Schema } from "../domain/definition/schema.ts";
import { definitionId, type Outcome } from "../domain/shared.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

const COMPOSED_WORKFLOW = definitionId("workflow.test-compose");

const source = `# Test workflow composition

\`\`\`phenix-workflow
id: workflow.test-compose
description: Invoke the implementation workflow and return its typed result.
input: request.implementation.v1
output: outcome.implementation-result.v1
entry: implement
timeout-ms: 2400000
max-node-runs: 4
max-parallelism: 1
\`\`\`

## States

### implement

\`\`\`phenix-state
kind: invoke
run: workflow.implement
input: input.identity
wait: await
\`\`\`

### return

\`\`\`phenix-state
kind: return
output: test.composed.output
\`\`\`

## Transitions

| From | To | When | Max traversals |
|---|---|---|---|
| \`implement\` | \`return\` | | |
`;

const schemas = new Map<string, Schema<unknown>>([
  [ImplementationRequestSchema.id, ImplementationRequestSchema as Schema<unknown>],
  [ImplementationResultSchema.id, ImplementationResultSchema as Schema<unknown>],
]);

const bindings: WorkflowMarkdownBindings = {
  resolveSchema(id) {
    const schema = schemas.get(id);
    if (!schema) throw new Error(`Unknown schema ${id}`);
    return schema;
  },
};

test("a Markdown workflow can invoke and await another workflow", async () => {
  const definition = compileWorkflowMarkdown(source, bindings);
  const runtime = await createTestRuntime(undefined, {
    definitions: [definition],
    rootInvokableDefinitions: [COMPOSED_WORKFLOW],
    registerFunctions(functions) {
      functions.registerMapping("test.composed.output", (context) => {
        const outcome = context.latest.get("implement") as
          | Outcome<ImplementationResult>
          | undefined;
        if (outcome?.status !== "success") {
          throw new Error("Nested implementation workflow did not succeed");
        }
        return outcome.value;
      });
    },
  });

  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, ImplementationResult>(COMPOSED_WORKFLOW),
    input: { objective: "Implement through a composed workflow" },
    wait: "await",
  });
  const outcome = await handle.result();

  assert.equal(outcome.status, "success");
  if (outcome.status !== "success") return;
  assert.equal(outcome.value.attempts, 1);

  const nested = runtime.store.projection.childrenOf(handle.id);
  assert.deepEqual(
    nested.map((run) => run.definitionId),
    [WORKFLOW_IMPLEMENT],
  );
  assert.deepEqual(
    runtime.store.projection.childrenOf(nested[0].id).map((run) => run.definitionId),
    ["agent.planner", "agent.implementer", "agent.verifier"],
  );
});
