import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_BASE } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import { success } from "../domain/shared.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("reducer invariants are validated before events reach the ledger", async () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
  });
  await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "remain active" },
    wait: "background",
  });
  const before = runtime.store.sequence(runtime.rootRunId);

  await assert.rejects(
    () =>
      runtime.store.commit(runtime.rootRunId, [
        {
          runId: runtime.rootRunId,
          type: "run.completed",
          data: { outcome: success({}) },
        },
      ]),
    /active attached children/,
  );
  assert.equal(runtime.store.sequence(runtime.rootRunId), before);

  await runtime.execution.cancel(runtime.rootRunId, "test cleanup");
  assert.equal(runtime.store.projection.requireRun(runtime.rootRunId).state, "cancelled");
});

test("terminal event type and typed outcome must agree", async () => {
  const runtime = await createTestRuntime();
  const before = runtime.store.sequence(runtime.rootRunId);

  await assert.rejects(
    () =>
      runtime.store.commit(runtime.rootRunId, [
        {
          runId: runtime.rootRunId,
          type: "run.failed",
          data: { outcome: success({}) },
        },
      ]),
    /requires failure/,
  );
  assert.equal(runtime.store.sequence(runtime.rootRunId), before);
});
