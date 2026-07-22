import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionEvent,
  ChildSessionSpec,
} from "../packages/phenix-suite/runtime/child-session-types.ts";
import { ChildRuntimeError } from "../packages/phenix-suite/runtime/child-session-types.ts";
import { TimedChildSessionBackend } from "../packages/phenix-suite/runtime/timed-child-session-backend.ts";

function fakeRun(): ChildRun {
  const listeners = new Set<(event: ChildSessionEvent) => void>();
  return {
    id: "run" as ChildRun["id"],
    backend: "sdk",
    pi: { sessionId: "session" },
    snapshot: () => ({}) as ReturnType<ChildRun["snapshot"]>,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async continue() {
      return { cycle: 1, status: "settled" };
    },
    async waitForCurrentCycle() {
      return { cycle: 1, status: "settled" };
    },
    async abort() {},
    async dispose() {
      for (const listener of listeners) {
        listener({ type: "session.disposed", runId: "run" as ChildRun["id"] });
      }
    },
  };
}

describe("TimedChildSessionBackend", () => {
  it("aborts the adapter signal when an idle child exceeds its budget", async () => {
    let adapterSignal: AbortSignal | undefined;
    const delegate: ChildSessionBackend = {
      kind: "sdk",
      async start(_spec, signal) {
        adapterSignal = signal;
        return fakeRun();
      },
    };
    const backend = new TimedChildSessionBackend(delegate);
    const run = await backend.start(
      { id: "run", timeoutMs: 5 } as unknown as ChildSessionSpec,
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(adapterSignal?.aborted, true);
    assert.ok(adapterSignal?.reason instanceof ChildRuntimeError);
    assert.equal((adapterSignal?.reason as ChildRuntimeError).code, "TIMEOUT");
    await run.dispose();
  });

  it("forwards parent cancellation unchanged", async () => {
    let adapterSignal: AbortSignal | undefined;
    const delegate: ChildSessionBackend = {
      kind: "sdk",
      async start(_spec, signal) {
        adapterSignal = signal;
        return fakeRun();
      },
    };
    const parent = new AbortController();
    const backend = new TimedChildSessionBackend(delegate);
    const run = await backend.start(
      { id: "run", timeoutMs: 1_000 } as unknown as ChildSessionSpec,
      parent.signal,
    );
    const reason = new Error("parent cancelled");
    parent.abort(reason);
    assert.equal(adapterSignal?.reason, reason);
    await run.dispose();
  });
});
