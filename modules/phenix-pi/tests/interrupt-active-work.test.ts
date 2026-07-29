import assert from "node:assert/strict";
import test from "node:test";

import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import { AGENT_BASE } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { RunId } from "../domain/shared.ts";
import { interruptActiveRootWork } from "../extension/workspace/interrupt-active-work.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("interrupt cancels the attached foreground subtree and preserves detached background work", async () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
  });

  const foreground = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "foreground" },
    wait: "background",
  });
  const nested = await runtime.execution.start({
    parentId: foreground.id,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "nested foreground work" },
    wait: "background",
  });
  const background = await runtime.execution.start({
    parentId: foreground.id,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "detached background work" },
    wait: "background",
  });
  await runtime.execution.reparent(background.id, runtime.rootRunId);

  assert.deepEqual(await interruptActiveRootWork(runtime, runtime.rootRunId), [foreground.id]);
  assert.equal(runtime.store.projection.requireRun(foreground.id).state, "cancelled");
  assert.equal(runtime.store.projection.requireRun(nested.id).state, "cancelled");
  assert.equal(runtime.store.projection.requireRun(background.id).state, "running");
});

test("interrupt is a no-op when the root has no attached foreground work", async () => {
  let cancelled = false;
  const rootRunId = "root-test" as RunId;
  const runtime = {
    queries: {
      activeRuns: async () => [
        { id: rootRunId, parentId: undefined, ownership: "attached" },
        {
          id: "run-detached" as RunId,
          parentId: rootRunId,
          ownership: "detached",
        },
      ],
    },
    execution: {
      cancel: async () => {
        cancelled = true;
      },
    },
  } as unknown as Pick<PhenixRuntime, "execution" | "queries">;

  assert.deepEqual(await interruptActiveRootWork(runtime, rootRunId), []);
  assert.equal(cancelled, false);
});
