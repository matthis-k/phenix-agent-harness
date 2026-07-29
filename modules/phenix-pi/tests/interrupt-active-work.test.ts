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

test("interrupt cancels every attached root child and leaves propagation to execution", async () => {
  const cancellations: Array<{ readonly runId: RunId; readonly reason: string }> = [];
  const runtime = {
    execution: {
      inspect: async (runId: RunId) => {
        assert.equal(runId, rootRunId);
        return { activeChildren: [firstRunId, secondRunId] };
      },
      cancel: async (runId: RunId, reason: string) => {
        cancellations.push({ runId, reason });
      },
    },
  } as unknown as Pick<PhenixRuntime, "execution">;

  const interrupted = await interruptActiveRootWork(runtime, rootRunId);

  assert.deepEqual(interrupted, [firstRunId, secondRunId]);
  assert.deepEqual(cancellations, [
    { runId: firstRunId, reason: USER_INTERRUPT_REASON },
    { runId: secondRunId, reason: USER_INTERRUPT_REASON },
  ]);
});

test("interrupt is a no-op when the root has no attached work", async () => {
  let cancelled = false;
  const runtime = {
    execution: {
      inspect: async () => ({ activeChildren: [] }),
      cancel: async () => {
        cancelled = true;
      },
    },
  } as unknown as Pick<PhenixRuntime, "execution">;

  assert.deepEqual(await interruptActiveRootWork(runtime, rootRunId), []);
  assert.equal(cancelled, false);
});
