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

const definitionsById = new Map(
  [...agentDefinitions, ...workflowDefinitions].map((definition) => [
    String(definition.id),
    definition,
  ] as const),
);

function reachesCommandAuthority(id: string, visited = new Set<string>()): boolean {
  if (visited.has(id)) return false;
  const definition = definitionsById.get(id);
  if (!definition) return false;
  const nextVisited = new Set(visited).add(id);

  if (definition.kind === "agent") {
    const tools = new Set(definition.tools.allow);
    if (tools.has("bash") && tools.has("nix_shell")) return true;
    if (!tools.has("phenix_run")) return false;
    return definition.childCapabilities.invokableDefinitions.some((childId) =>
      reachesCommandAuthority(String(childId), nextVisited),
    );
  }

  return definition.graph.nodes.some((node) => {
    if (node.kind === "local") return node.operation === "local.qa-checks";
    return (
      node.kind === "invoke" &&
      reachesCommandAuthority(String(node.definition.id), nextVisited)
    );
  });
}

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

test("command execution stays scoped to operational agents", () => {
  const byId = new Map(
    agentDefinitions.map((definition) => [String(definition.id), definition] as const),
  );
  for (const id of [
    "agent.tester",
    "agent.implementer",
    "agent.verifier",
    "agent.critic",
    "agent.base",
  ]) {
    assert.ok(byId.get(id)?.tools.allow.includes("bash"), `${id} lacks bash`);
    assert.ok(byId.get(id)?.tools.allow.includes("nix_shell"), `${id} lacks nix_shell`);
  }
  for (const id of ["agent.scout", "agent.planner", "agent.architect", "agent.finalizer"]) {
    assert.equal(byId.get(id)?.tools.allow.includes("bash"), false, `${id} unexpectedly has bash`);
    assert.equal(
      byId.get(id)?.tools.allow.includes("nix_shell"),
      false,
      `${id} unexpectedly has nix_shell`,
    );
  }
});

test("every substantial dispatch route reaches command authority", () => {
  for (const id of ["workflow.qa", "workflow.implement", "agent.coordinator"]) {
    assert.equal(reachesCommandAuthority(id), true, `${id} cannot reach command authority`);
  }
});

test("dispatch prompts prohibit read-only command fallbacks", () => {
  const coordinator = definitionsById.get("agent.coordinator");
  const dispatcher = definitionsById.get("agent.dispatcher");
  assert.equal(coordinator?.kind, "agent");
  assert.equal(dispatcher?.kind, "agent");
  if (coordinator?.kind === "agent") {
    assert.match(coordinator.prompt.render(), /Never route command execution to agent\.scout/);
    assert.match(coordinator.prompt.render(), /explicitly shell-capable operational child/);
  }
  if (dispatcher?.kind === "agent") {
    assert.match(dispatcher.prompt.render(), /full repository QA/);
    assert.match(dispatcher.prompt.render(), /never use a read-only analysis role/);
  }
});

test("agent context inheritance is scoped to role needs", () => {
  const byId = new Map(
    agentDefinitions.map((definition) => [String(definition.id), definition] as const),
  );

  for (const id of [
    "agent.dispatcher",
    "agent.coordinator",
    "agent.finalizer",
    "agent.qa-synthesizer",
  ]) {
    const definition = byId.get(id);
    assert.ok(definition);
    assert.equal(definition.context.projectFiles, "none");
    assert.equal(definition.context.maxBytes, 0);
    assert.equal(definition.context.parentConversation, "none");
  }

  assert.equal(byId.get("agent.tester")?.context.maxBytes, 32_000);
  for (const id of ["agent.scout", "agent.planner", "agent.architect", "agent.critic"]) {
    const definition = byId.get(id);
    assert.ok(definition);
    assert.equal(definition.context.projectFiles, "inherit");
    assert.equal(definition.context.maxBytes, 64_000);
  }

  for (const id of ["agent.implementer", "agent.verifier", "agent.base"]) {
    const definition = byId.get(id);
    assert.ok(definition);
    assert.equal(definition.context.projectFiles, "inherit");
    assert.equal(definition.context.maxBytes, 128_000);
  }
});

test("structured presentation is available only to operational agents", () => {
  const byId = new Map(
    agentDefinitions.map((definition) => [String(definition.id), definition] as const),
  );
  for (const id of [
    "agent.scout",
    "agent.planner",
    "agent.architect",
    "agent.implementer",
    "agent.tester",
    "agent.verifier",
    "agent.critic",
    "agent.finalizer",
    "agent.coordinator",
    "agent.base",
  ]) {
    assert.ok(byId.get(id)?.tools.allow.includes("phenix_present"), id);
  }
  assert.equal(byId.get("agent.dispatcher")?.tools.allow.includes("phenix_present"), false);
  assert.equal(byId.get("agent.qa-synthesizer")?.tools.allow.includes("phenix_present"), false);
});
