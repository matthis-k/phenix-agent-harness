import assert from "node:assert/strict";
import test from "node:test";

import type { DynamicWorkflowProposal } from "../definitions/dynamic-workflow.ts";
import { AGENT_SCOUT } from "../definitions/ids.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

function scoutWorkflow(): DynamicWorkflowProposal {
  return {
    title: "Dynamic repository scout",
    description: "Adapt the root objective to the reusable scout building block.",
    inputSchema: "request.objective.v1",
    outputSchema: "outcome.scout-report.v1",
    entry: "scout",
    nodes: [
      {
        kind: "invoke",
        id: "scout",
        definitionId: AGENT_SCOUT,
        input: {
          source: "object",
          fields: {
            objective: { source: "input", path: ["objective"] },
            focus: { source: "literal", value: "runtime execution" },
          },
        },
      },
      {
        kind: "return",
        id: "return",
        output: { source: "node", nodeId: "scout" },
      },
    ],
    edges: [{ from: "scout", to: "return" }],
    limits: {
      timeoutMs: 120_000,
      maxNodeRuns: 2,
      maxParallelism: 1,
    },
  };
}

test("trusted dynamic workflows execute through the ordinary workflow lifecycle", async () => {
  const runtime = await createTestRuntime(undefined, {
    rootInvokableDefinitions: [AGENT_SCOUT],
  });

  const handle = await runtime.dynamicWorkflows.start({
    parentId: runtime.rootRunId,
    scopeRunId: runtime.rootRunId,
    proposal: scoutWorkflow(),
    input: { objective: "Inspect dynamic workflow execution" },
    wait: "await",
  });
  const outcome = await handle.result();
  const run = runtime.store.projection.requireRun(handle.id);
  const children = runtime.store.projection.childrenOf(handle.id);

  assert.equal(outcome.status, "success");
  assert.deepEqual(outcome.value, {
    summary: "scouted",
    evidence: [{ path: "src/file.ts", finding: "ok" }],
    risks: [],
  });
  assert.match(run.definitionId, /^workflow\.dynamic\.[a-f0-9]{24}$/);
  assert.equal(run.compiled.dynamicWorkflow?.identity.version, 1);
  assert.equal(run.compiled.dynamicWorkflow?.identity.graphDigest.length, 64);
  assert.deepEqual(run.compiled.capabilities.invokableDefinitions, [AGENT_SCOUT]);
  assert.equal(children.length, 1);
  assert.equal(children[0]?.definitionId, AGENT_SCOUT);
});

test("dynamic workflow execution rechecks the concrete composition scope", async () => {
  const runtime = await createTestRuntime(undefined, {
    rootInvokableDefinitions: [],
  });

  await assert.rejects(
    runtime.dynamicWorkflows.start({
      parentId: runtime.rootRunId,
      scopeRunId: runtime.rootRunId,
      proposal: scoutWorkflow(),
      input: { objective: "Attempt unauthorized composition" },
      wait: "await",
    }),
    /unavailable definition/,
  );
  assert.equal(runtime.store.projection.childrenOf(runtime.rootRunId).length, 0);
});

test("dynamic workflow restoration is idempotent for persisted live contracts", async () => {
  const runtime = await createTestRuntime(undefined, {
    rootInvokableDefinitions: [AGENT_SCOUT],
  });
  const handle = await runtime.dynamicWorkflows.start({
    parentId: runtime.rootRunId,
    scopeRunId: runtime.rootRunId,
    proposal: scoutWorkflow(),
    input: { objective: "Restore the persisted graph" },
    wait: "await",
  });

  await runtime.dynamicWorkflows.restoreRoot(runtime.rootRunId);
  const snapshot = await handle.snapshot();
  assert.equal(snapshot.state, "completed");
  assert.ok(snapshot.compiled.dynamicWorkflow);
});
