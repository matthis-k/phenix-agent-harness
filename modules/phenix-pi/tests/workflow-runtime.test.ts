import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_IMPLEMENT, WORKFLOW_QA, WORKFLOW_QA_FIX } from "../definitions/ids.ts";
import type { ImplementationResult } from "../definitions/schemas.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("implementation workflow invokes typed children and returns verified output", async () => {
  const runtime = await createTestRuntime();
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, ImplementationResult>(WORKFLOW_IMPLEMENT),
    input: { objective: "Implement the change" },
    wait: "await",
  });
  const outcome = await handle.result();

  assert.equal(outcome.status, "success");
  if (outcome.status !== "success") return;
  assert.equal(outcome.value.attempts, 1);
  assert.equal(outcome.value.verification.accepted, true);

  const workflow = runtime.store.projection.requireRun(handle.id);
  const children = runtime.store.projection.childrenOf(handle.id);
  assert.equal(workflow.state, "completed");
  assert.deepEqual(
    children.map((child) => child.definitionId),
    ["agent.planner", "agent.implementer", "agent.verifier"],
  );
  assert.ok(children.every((child) => child.parentId === handle.id));
});

test("implementation workflow performs a bounded typed repair loop", async () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  let verifications = 0;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
      if (command.definition.id === "agent.planner") {
        await runtime.controller.complete(command.runId, {
          summary: "plan",
          steps: ["edit"],
          constraints: [],
          checks: ["test"],
        });
        return;
      }
      if (command.definition.id === "agent.implementer") {
        await runtime.controller.complete(command.runId, {
          summary: "implemented",
          changedFiles: ["src/file.ts"],
          checks: [{ command: "test", ok: true, summary: "passed" }],
          unresolved: [],
        });
        return;
      }
      verifications += 1;
      await runtime.controller.complete(command.runId, {
        accepted: verifications > 1,
        summary: verifications > 1 ? "accepted" : "repair required",
        findings: verifications > 1 ? [] : ["fix regression"],
        evidence: ["test output"],
      });
    },
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, ImplementationResult>(WORKFLOW_IMPLEMENT),
    input: { objective: "repair once" },
    wait: "await",
  });
  const outcome = await handle.result();
  assert.equal(outcome.status, "success");
  if (outcome.status !== "success") return;
  assert.equal(outcome.value.attempts, 2);
  assert.equal(verifications, 2);
});

test("workflow cancellation aborts and joins owned local operations", async () => {
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  const operations: LocalOperationRunner = {
    has: (operation) => operation === "local.noop",
    async run(_operation, _input, context) {
      observedSignal = context.signal;
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener(
          "abort",
          () => reject(context.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
  };
  const runtime = await createTestRuntime(undefined, { operations });
  const starting = runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_QA),
    input: { objective: "cancel during local work" },
    wait: "await",
  });
  await started;
  const workflow = [...runtime.store.projection.runs.values()].find(
    (run) => run.definitionId === WORKFLOW_QA,
  );
  assert.ok(workflow);

  await runtime.execution.cancel(workflow.id, "user cancelled");
  const handle = await starting;
  assert.equal(observedSignal?.aborted, true);
  assert.equal(runtime.store.projection.requireRun(handle.id).state, "cancelled");
});

test("nested QA-and-fix workflow is invoked through the same run boundary", async () => {
  const runtime = await createTestRuntime();
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_QA_FIX),
    input: { objective: "Audit and repair" },
    wait: "await",
  });
  const outcome = await handle.result();
  assert.equal(outcome.status, "success");
  if (outcome.status !== "success") return;
  assert.equal((outcome.value as { changed: boolean }).changed, false);
  const nested = runtime.store.projection
    .childrenOf(handle.id)
    .find((run) => run.definitionId === "workflow.qa");
  assert.ok(nested);
  assert.equal(nested.parentId, handle.id);
  assert.equal(nested.state, "completed");
});
