import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_BASE } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("aborting an await never cancels the attached child", async () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "keep running" },
    wait: "await",
  });
  const abort = new AbortController();
  const waiting = handle.result(abort.signal);
  abort.abort("user interrupted the wait");
  await assert.rejects(waiting, /user interrupted/u);
  assert.equal(runtime.store.projection.requireRun(handle.id).state, "running");
});
