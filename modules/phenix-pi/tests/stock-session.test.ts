import assert from "node:assert/strict";
import test from "node:test";

import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { CatalogFacadeImpl } from "../application/catalog-facade.ts";
import type {
  RunImplementation,
  StartImplementationCommand,
} from "../application/execution-facade.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import type { DynamicWorkflowProposal } from "../definitions/dynamic-workflow.ts";
import { AGENT_CRITIC, SESSION_STOCK } from "../definitions/ids.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

function directStockWorkflow(): DynamicWorkflowProposal {
  return {
    title: "Direct stock session",
    description: "Use one stock Pi session and return its typed result directly.",
    inputSchema: "request.objective",
    outputSchema: "outcome.scout-report",
    entry: "stock",
    nodes: [
      {
        kind: "invoke",
        id: "stock",
        definitionId: SESSION_STOCK,
        outputSchema: "outcome.scout-report",
        input: {
          source: "object",
          fields: {
            task: { source: "input", path: ["objective"] },
            context: { source: "literal", value: { focus: "stock execution" } },
          },
        },
      },
      {
        kind: "return",
        id: "return",
        output: { source: "node", nodeId: "stock" },
      },
    ],
    edges: [{ from: "stock", to: "return" }],
    limits: { timeoutMs: 120_000, maxNodeRuns: 2, maxParallelism: 1 },
  };
}

function verifiedStockWorkflow(): DynamicWorkflowProposal {
  return {
    title: "Verified stock session",
    description: "Use a stock Pi session and explicitly route its result through a critic.",
    inputSchema: "request.objective",
    outputSchema: "outcome.critic-report",
    entry: "stock",
    nodes: [
      ...directStockWorkflow().nodes.filter((node) => node.id === "stock"),
      {
        kind: "invoke",
        id: "critic",
        definitionId: AGENT_CRITIC,
        input: {
          source: "object",
          fields: {
            objective: { source: "input", path: ["objective"] },
            artifact: { source: "node", nodeId: "stock" },
            focus: { source: "literal", value: "independent verification" },
          },
        },
      },
      {
        kind: "return",
        id: "return",
        output: { source: "node", nodeId: "critic" },
      },
    ],
    edges: [
      { from: "stock", to: "critic" },
      { from: "critic", to: "return" },
    ],
    limits: { timeoutMs: 180_000, maxNodeRuns: 3, maxParallelism: 1 },
  };
}

test("the catalog exposes stock Pi as a session with a dynamic output", async () => {
  const runtime = await createTestRuntime(undefined, {
    rootInvokableDefinitions: [SESSION_STOCK],
  });
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const definitions = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions]) {
    definitions.register(definition);
  }
  definitions.seal(functions, {
    has: (operation) => operation === "local.noop" || operation === "local.qa-checks",
    async run() {
      return undefined;
    },
  });
  const catalog = new CatalogFacadeImpl(definitions, runtime.store);
  const entries = await catalog.listAvailable(runtime.rootRunId);
  const stock = entries.find((entry) => entry.id === SESSION_STOCK);

  assert.ok(stock);
  assert.equal(stock.kind, "session");
  assert.equal(stock.inputSchema, "request.stock-session");
  assert.equal(stock.outputSchema, "dynamic");
});

test("a dynamic workflow may return stock output directly without a verifier", async () => {
  const runtime = await createTestRuntime(undefined, {
    rootInvokableDefinitions: [SESSION_STOCK],
  });
  const handle = await runtime.dynamicWorkflows.start({
    parentId: runtime.rootRunId,
    scopeRunId: runtime.rootRunId,
    proposal: directStockWorkflow(),
    input: { objective: "Inspect the repository with an ordinary Pi session" },
    wait: "await",
  });
  const outcome = await handle.result();
  const children = runtime.store.projection.childrenOf(handle.id);
  const stockInput = children[0]?.input as Readonly<Record<string, unknown>> | undefined;

  assert.equal(outcome.status, "success");
  assert.deepEqual(outcome.value, {
    summary: "stock result",
    evidence: [{ path: "src/file.ts", finding: "stock evidence" }],
    risks: [],
  });
  assert.deepEqual(
    children.map((child) => child.definitionId),
    [SESSION_STOCK],
  );
  assert.equal(stockInput?.outputSchema, "outcome.scout-report");
  assert.equal(typeof stockInput?.outputContract, "object");
});

test("verification is added only when the workflow explicitly invokes it", async () => {
  const runtime = await createTestRuntime(undefined, {
    rootInvokableDefinitions: [SESSION_STOCK, AGENT_CRITIC],
  });
  const handle = await runtime.dynamicWorkflows.start({
    parentId: runtime.rootRunId,
    scopeRunId: runtime.rootRunId,
    proposal: verifiedStockWorkflow(),
    input: { objective: "Inspect and independently review the repository" },
    wait: "await",
  });
  const outcome = await handle.result();
  const children = runtime.store.projection.childrenOf(handle.id);

  assert.equal(outcome.status, "success");
  assert.deepEqual(outcome.value, { summary: "reviewed", findings: [] });
  assert.deepEqual(
    children.map((child) => child.definitionId),
    [SESSION_STOCK, AGENT_CRITIC],
  );
});

test("malformed stock output fails the workflow before downstream execution", async () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  const implementation: RunImplementation = {
    async start(command: StartImplementationCommand) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
      await runtime.controller.complete(command.runId, {
        outputSchema: "outcome.scout-report",
        value: { summary: "missing required fields" },
      });
    },
  };
  runtime = await createTestRuntime(implementation, {
    rootInvokableDefinitions: [SESSION_STOCK],
  });
  const handle = await runtime.dynamicWorkflows.start({
    parentId: runtime.rootRunId,
    scopeRunId: runtime.rootRunId,
    proposal: directStockWorkflow(),
    input: { objective: "Return malformed stock output" },
    wait: "await",
  });
  const outcome = await handle.result();

  assert.equal(outcome.status, "failure");
  if (outcome.status === "failure") {
    assert.equal(outcome.failure.code, "output_invalid");
    assert.match(outcome.failure.message, /Stock session stock output is invalid/);
  }
});
