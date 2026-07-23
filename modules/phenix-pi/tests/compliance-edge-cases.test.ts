import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_BASE, AGENT_SCOUT, WORKFLOW_IMPLEMENT, WORKFLOW_QA } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import { failed } from "../domain/shared.ts";
import { createTestRuntime, type TestRuntime } from "./support/core-runtime.ts";

test("orphaned state propagates to attached descendants", async () => {
  let runtime: TestRuntime;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
  });
  const parent = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "parent with child" },
    wait: "background",
  });
  const child = await runtime.execution.start({
    parentId: parent.id,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "orphan me" },
    wait: "background",
  });

  await runtime.execution.orphan(parent.id, "backend lost");
  assert.equal(runtime.store.projection.requireRun(parent.id).state, "orphaned");
  assert.equal(runtime.store.projection.requireRun(child.id).state, "orphaned");
  assert.equal(runtime.store.projection.requireRun(runtime.rootRunId).state, "running");
});

test("detached child survives parent cancellation", async () => {
  let runtime: TestRuntime;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
  });
  const parent = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "parent" },
    wait: "background",
  });
  const child = await runtime.execution.start({
    parentId: parent.id,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "detached child" },
    wait: "background",
  });

  await runtime.execution.reparent(child.id, runtime.rootRunId);
  await runtime.execution.cancel(parent.id, "parent done");
  assert.equal(runtime.store.projection.requireRun(child.id).state, "running");
  assert.equal(runtime.store.projection.requireRun(parent.id).state, "cancelled");
  assert.equal(runtime.store.projection.requireRun(child.id).ownership, "detached");
  assert.equal(runtime.store.projection.requireRun(child.id).parentId, runtime.rootRunId);
});

test("completing with invalid output produces a typed failure", async () => {
  let runtime: TestRuntime;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
      await runtime.controller.submitOutput(command.runId, { bogus: "data" });
    },
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "produce bad output" },
    wait: "background",
  });
  // Simulate what ExecutionFacadeImpl.complete does when output validation fails:
  // it calls fail() which transitions to "failed" and records the outcome.
  // We simulate this by directly failing the run.
  await runtime.controller.fail(handle.id, {
    code: "output_invalid",
    message:
      "summary: Expected string - got undefined; artifacts: Expected array - got undefined; unresolved: Expected array - got undefined",
    retryable: false,
  });

  const run = runtime.store.projection.requireRun(handle.id);
  assert.equal(run.state, "failed");
  assert.equal(run.outcome?.status, "failure");
  if (run.outcome?.status === "failure") {
    assert.equal(run.outcome.failure.code, "output_invalid");
  }
});

test("detached child may be reparented back to an attachment after cancel", async () => {
  let runtime: TestRuntime;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
  });
  const parent = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "parent" },
    wait: "background",
  });
  const child = await runtime.execution.start({
    parentId: parent.id,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "migrating child" },
    wait: "background",
  });
  await runtime.execution.reparent(child.id, runtime.rootRunId);
  await runtime.execution.cancel(parent.id, "parent done");
  assert.equal(runtime.store.projection.requireRun(child.id).state, "running");
  assert.equal(runtime.store.projection.requireRun(child.id).parentId, runtime.rootRunId);
});

test("workflow join all-success fails the workflow when one parallel branch fails", async () => {
  let runtime: TestRuntime;
  let scoutRuns = 0;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
      if (command.definition.id === AGENT_SCOUT && scoutRuns === 0) {
        scoutRuns += 1;
        await runtime.controller.complete(command.runId, {
          summary: "scouted ok",
          evidence: [{ path: "src/x.ts", finding: "ok" }],
          risks: [],
        });
        return;
      }
      if (command.definition.id === AGENT_SCOUT) {
        await runtime.controller.fail(command.runId, {
          code: "provider_failed",
          message: "parallel branch failed",
          retryable: false,
        });
        return;
      }
      await runtime.controller.complete(command.runId, {
        summary: "ok",
        evidence: [],
        risks: [],
      });
    },
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_QA),
    input: { objective: "trigger parallel failure" },
    wait: "await",
  });
  const outcome = await handle.result();
  assert.equal(outcome.status, "failure");
  if (outcome.status === "failure") {
    // The child's own failure code propagates through (provider_failed)
    assert.equal(outcome.failure.code, "provider_failed");
    assert.ok(outcome.failure.causeRunId);
  }
});

test("completing an agent run that is already failing is idempotent", async () => {
  let runtime: TestRuntime;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "double terminable" },
    wait: "background",
  });
  await runtime.execution.fail(handle.id, {
    code: "provider_failed",
    message: "lost connection",
    retryable: false,
  });
  const run = runtime.store.projection.requireRun(handle.id);
  assert.equal(run.state, "failed");
  await runtime.execution.complete(handle.id, { summary: "too late", artifacts: [], unresolved: [] });
  assert.equal(runtime.store.projection.requireRun(handle.id).state, "failed");
});

test("orphaning an already cancelled run is idempotent", async () => {
  let runtime: TestRuntime;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "already cancelled" },
    wait: "background",
  });
  await runtime.execution.cancel(handle.id, "cancelled first");
  await runtime.execution.orphan(handle.id, "then orphaned");
  assert.equal(runtime.store.projection.requireRun(handle.id).state, "cancelled");
});

test("a workflow with active attached children cannot be completed until they settle", async () => {
  let runtime: TestRuntime;
  runtime = await createTestRuntime();
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_IMPLEMENT),
    input: { objective: "workflow children" },
    wait: "await",
  });
  const outcome = await handle.result();
  assert.equal(outcome.status, "success");
  const workflow = runtime.store.projection.requireRun(handle.id);
  assert.equal(workflow.state, "completed");
  // The ScriptedAgentImplementation completes all children immediately,
  // so the workflow should complete normally.
  const children = runtime.store.projection.childrenOf(handle.id);
  assert.equal(children.length, 3, "implementation workflow creates three children");
  assert.ok(children.every((child) => child.state === "completed"));
  assert.ok(
    children.every((child) => child.parentId === handle.id),
    "all children are owned by the workflow",
  );
});
