import assert from "node:assert/strict";
import test from "node:test";

import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";

test("all bundled workflow graphs validate at startup", () => {
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const catalog = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions])
    catalog.register(definition);
  catalog.seal(functions, {
    has: (operation) => operation === "local.noop",
    async run() {
      return undefined;
    },
  });
  assert.deepEqual(catalog.validateAll(), []);
  const workflow = catalog.require(workflowDefinitions[0].id);
  assert.equal(Object.isFrozen(workflow), true);
  if (workflow.kind === "workflow") {
    assert.equal(Object.isFrozen(workflow.graph), true);
    assert.equal(Object.isFrozen(workflow.graph.nodes), true);
    assert.equal(Object.isFrozen(workflow.graph.edges), true);
  }
});

test("workflow function names are unique authorities", () => {
  const functions = new WorkflowFunctionRegistry();
  functions.registerMapping("mapping", () => undefined);
  assert.throws(
    () => functions.registerMapping("mapping", () => undefined),
    /Duplicate workflow mapping/,
  );
});
