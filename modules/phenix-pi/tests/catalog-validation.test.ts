import assert from "node:assert/strict";
import test from "node:test";

import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";

const localOperations = {
  has: (operation: string) => operation === "local.noop" || operation === "local.qa-checks",
  async run() {
    return undefined;
  },
};

test("all bundled workflow graphs validate at startup", () => {
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const catalog = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions])
    catalog.register(definition);
  catalog.seal(functions, localOperations);
  assert.deepEqual(catalog.validateAll(), []);
  const workflow = catalog.require(workflowDefinitions[0].id);
  assert.equal(Object.isFrozen(workflow), true);
  if (workflow.kind === "workflow") {
    assert.equal(Object.isFrozen(workflow.graph), true);
    assert.equal(Object.isFrozen(workflow.graph.nodes), true);
    assert.equal(Object.isFrozen(workflow.graph.edges), true);
  }
});

test("only invariant procedures are declared as workflows", () => {
  assert.deepEqual(
    workflowDefinitions.map((workflow) => workflow.id),
    ["workflow.implement", "workflow.qa"],
  );
  const qa = workflowDefinitions.find((workflow) => workflow.id === "workflow.qa");
  assert.ok(qa);
  assert.ok(
    qa.graph.nodes.some((node) => node.kind === "local" && node.operation === "local.qa-checks"),
  );
  assert.ok(
    qa.graph.nodes.some((node) => node.kind === "invoke" && node.definition.id === "agent.tester"),
  );
});

test("workflow function names are unique authorities", () => {
  const functions = new WorkflowFunctionRegistry();
  functions.registerMapping("mapping", () => undefined);
  assert.throws(
    () => functions.registerMapping("mapping", () => undefined),
    /Duplicate workflow mapping/,
  );
});

test("bundled agents omit tool-call caps by default", () => {
  for (const definition of agentDefinitions) {
    assert.equal(definition.limits.maxToolCalls, undefined);
    assert.ok(definition.limits.timeoutMs > 0);
  }
});

test("open-ended QA analysis agents omit fixed turn caps", () => {
  const qaAgentIds = new Set(["agent.scout", "agent.tester", "agent.architect", "agent.critic"]);
  const qaAgents = agentDefinitions.filter((definition) => qaAgentIds.has(definition.id));
  assert.equal(qaAgents.length, qaAgentIds.size);
  for (const definition of qaAgents) assert.equal(definition.limits.maxTurns, undefined);
});
