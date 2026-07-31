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
  [...agentDefinitions, ...workflowDefinitions].map(
    (definition) => [String(definition.id), definition] as const,
  ),
);

function reachesCommandAuthority(id: string, visited = new Set<string>()): boolean {
  if (visited.has(id)) return false;
  const definition = definitionsById.get(id);
  if (!definition) return false;
  const nextVisited = new Set(visited).add(id);

  if (definition.kind === "agent") {
    if (definition.sessionMode === "stock") return true;
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
      node.kind === "invoke" && reachesCommandAuthority(String(node.definition.id), nextVisited)
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

test("the workflow catalog contains only bounded invariant procedures", () => {
  const expectedWorkflowIds = [
    "workflow.debug",
    "workflow.design",
    "workflow.implement",
    "workflow.migrate",
    "workflow.qa",
    "workflow.refactor",
    "workflow.research",
    "workflow.review",
    "workflow.security",
    "workflow.ui-change",
  ];
  assert.deepEqual(workflowDefinitions.map((workflow) => workflow.id).sort(), expectedWorkflowIds);

  const qa = workflowDefinitions.find((workflow) => workflow.id === "workflow.qa");
  assert.ok(qa);
  assert.ok(
    qa.graph.nodes.some((node) => node.kind === "local" && node.operation === "local.qa-checks"),
  );
  assert.ok(
    qa.graph.nodes.some((node) => node.kind === "invoke" && node.definition.id === "agent.tester"),
  );

  const debug = workflowDefinitions.find((workflow) => workflow.id === "workflow.debug");
  assert.ok(debug);
  assert.ok(
    debug.graph.nodes.some(
      (node) => node.kind === "invoke" && node.definition.id === "agent.reproducer",
    ),
  );
  assert.ok(
    debug.graph.nodes.some(
      (node) => node.kind === "invoke" && node.definition.id === "workflow.implement",
    ),
  );

  const research = workflowDefinitions.find((workflow) => workflow.id === "workflow.research");
  assert.ok(research);
  assert.ok(research.graph.nodes.some((node) => node.kind === "join"));
  assert.equal(
    research.graph.nodes.filter(
      (node) => node.kind === "invoke" && node.definition.id === "agent.researcher",
    ).length,
    3,
  );

  const security = workflowDefinitions.find((workflow) => workflow.id === "workflow.security");
  assert.ok(security);
  assert.ok(
    security.graph.nodes.some(
      (node) => node.kind === "invoke" && node.definition.id === "agent.threat-modeler",
    ),
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

test("bundled definitions have explicit execution-authority classes", () => {
  const commandAgents = new Set([
    "agent.reproducer",
    "agent.researcher",
    "agent.threat-modeler",
    "agent.tester",
    "agent.implementer",
    "agent.verifier",
    "agent.critic",
    "agent.base",
  ]);
  const nonExecutingAgents = new Set([
    "agent.difficulty-estimator",
    "agent.scout",
    "agent.planner",
    "agent.architect",
    "agent.finalizer",
    "agent.dispatcher",
    "agent.coordinator",
    "agent.qa-synthesizer",
    "agent.attention-router",
  ]);
  const stockSessions = new Set(["session.stock"]);

  assert.equal(
    commandAgents.size + nonExecutingAgents.size + stockSessions.size,
    agentDefinitions.length,
  );
  for (const definition of agentDefinitions) {
    const id = String(definition.id);
    const classes = [
      commandAgents.has(id),
      nonExecutingAgents.has(id),
      stockSessions.has(id),
    ].filter(Boolean);
    assert.equal(classes.length, 1, `${id} must belong to exactly one execution-authority class`);
    if (stockSessions.has(id)) {
      assert.equal(definition.sessionMode, "stock");
      assert.deepEqual(definition.tools.allow, []);
      continue;
    }
    const hasBash = definition.tools.allow.includes("bash");
    const hasNixShell = definition.tools.allow.includes("nix_shell");
    assert.equal(hasBash, hasNixShell, `${id} must grant bash and nix_shell together`);
    assert.equal(hasBash, commandAgents.has(id), `${id} has the wrong shell authority`);
  }
});

test("predefined dispatch routes reach command authority while the composer only references it", () => {
  for (const workflow of workflowDefinitions) {
    assert.equal(
      reachesCommandAuthority(String(workflow.id)),
      true,
      `${workflow.id} cannot reach command authority`,
    );
  }

  const composer = definitionsById.get("agent.coordinator");
  assert.equal(composer?.kind, "agent");
  if (composer?.kind === "agent") {
    assert.deepEqual(composer.tools.allow, []);
    assert.equal(reachesCommandAuthority("agent.coordinator"), false);
    assert.ok(
      composer.childCapabilities.invokableDefinitions.some((id) =>
        reachesCommandAuthority(String(id)),
      ),
    );
  }
});

test("dispatch prompts distinguish stock sessions from controlled roles", () => {
  const coordinator = definitionsById.get("agent.coordinator");
  const dispatcher = definitionsById.get("agent.dispatcher");
  assert.equal(coordinator?.kind, "agent");
  assert.equal(dispatcher?.kind, "agent");
  if (coordinator?.kind === "agent") {
    assert.match(
      coordinator.prompt.render(),
      /Use session\.stock only when no predefined workflow/,
    );
    assert.match(coordinator.prompt.render(), /do not add verification automatically/);
    assert.match(coordinator.prompt.render(), /command-capable workflow or operational agent/);
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
  for (const id of [
    "agent.scout",
    "agent.reproducer",
    "agent.researcher",
    "agent.threat-modeler",
    "agent.planner",
    "agent.architect",
    "agent.critic",
  ]) {
    const definition = byId.get(id);
    assert.ok(definition);
    assert.equal(definition.context.projectFiles, "inherit");
    assert.equal(definition.context.maxBytes, 64_000);
  }

  for (const id of ["agent.implementer", "agent.verifier", "agent.base", "session.stock"]) {
    const definition = byId.get(id);
    assert.ok(definition);
    assert.equal(definition.context.projectFiles, "inherit");
    assert.equal(definition.context.maxBytes, 128_000);
  }
});

test("structured presentation is available only to operational Phenix agents", () => {
  const byId = new Map(
    agentDefinitions.map((definition) => [String(definition.id), definition] as const),
  );
  for (const id of [
    "agent.scout",
    "agent.reproducer",
    "agent.researcher",
    "agent.threat-modeler",
    "agent.planner",
    "agent.architect",
    "agent.implementer",
    "agent.tester",
    "agent.verifier",
    "agent.critic",
    "agent.finalizer",
    "agent.base",
  ]) {
    assert.ok(byId.get(id)?.tools.allow.includes("phenix_present"), id);
  }
  for (const id of [
    "agent.coordinator",
    "agent.dispatcher",
    "agent.qa-synthesizer",
    "session.stock",
  ]) {
    assert.equal(byId.get(id)?.tools.allow.includes("phenix_present"), false, id);
  }
});
