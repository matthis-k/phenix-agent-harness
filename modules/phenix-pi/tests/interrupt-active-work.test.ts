import assert from "node:assert/strict";
import test from "node:test";

import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import type { RunId } from "../domain/shared.ts";
import {
  interruptActiveRootWork,
  USER_INTERRUPT_REASON,
} from "../extension/workspace/interrupt-active-work.ts";

const rootRunId = "root-test" as RunId;
const firstRunId = "run-first" as RunId;
const secondRunId = "run-second" as RunId;
const detachedRunId = "run-detached" as RunId;
const nestedRunId = "run-nested" as RunId;

test("interrupt cancels attached foreground roots and leaves recursive propagation to execution", async () => {
  const cancellations: Array<{ readonly runId: RunId; readonly reason: string }> = [];
  const runtime = {
    queries: {
      activeRuns: async (runId: RunId) => {
        assert.equal(runId, rootRunId);
        return [
          { id: rootRunId, parentId: undefined, ownership: "attached" },
          { id: firstRunId, parentId: rootRunId, ownership: "attached" },
          { id: secondRunId, parentId: rootRunId, ownership: "attached" },
          { id: detachedRunId, parentId: rootRunId, ownership: "detached" },
          { id: nestedRunId, parentId: firstRunId, ownership: "attached" },
        ];
      },
    },
    execution: {
      cancel: async (runId: RunId, reason: string) => {
        cancellations.push({ runId, reason });
      },
    },
  } as unknown as Pick<PhenixRuntime, "execution" | "queries">;

  const interrupted = await interruptActiveRootWork(runtime, rootRunId);

  assert.deepEqual(interrupted, [firstRunId, secondRunId]);
  assert.deepEqual(cancellations, [
    { runId: firstRunId, reason: USER_INTERRUPT_REASON },
    { runId: secondRunId, reason: USER_INTERRUPT_REASON },
  ]);
});

test("interrupt is a no-op when the root has no attached foreground work", async () => {
  let cancelled = false;
  const runtime = {
    queries: {
      activeRuns: async () => [
        { id: rootRunId, parentId: undefined, ownership: "attached" },
        { id: detachedRunId, parentId: rootRunId, ownership: "detached" },
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
