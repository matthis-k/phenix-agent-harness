/**
 * child-session-registry.test.ts
 *
 * Verify:
 * - add/get/remove/list work correctly
 * - shutdown aborts and disposes all active runs
 * - repeated operations are safe
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  ChildSessionRegistry,
  resetChildSessionRegistry,
  getChildSessionRegistry,
} from "../extensions/phenix-runtime/child-session-registry.ts";
import type {
  ChildRun,
  ChildRunId,
  ChildSessionEvent,
  ChildCycleOutcome,
  ChildSessionNode,
  PiSessionReference,
} from "../extensions/phenix-runtime/child-session-types.ts";
import { childRunId } from "../extensions/phenix-runtime/child-session-types.ts";

// ── Fake child run ──────────────────────────────────────────────────────────

class FakeChildRun implements ChildRun {
  readonly id: ChildRunId;
  readonly backend = "sdk" as const;
  readonly pi: PiSessionReference;

  abortCalls = 0;
  disposeCalls = 0;

  constructor(id: ChildRunId) {
    this.id = id;
    this.pi = { sessionId: `pi-${id}` };
  }

  snapshot(): ChildSessionNode {
    return {
      id: this.id,
      rootId: this.id,
      handleId: "test",
      role: "scout",
      agentClient: { id: "scout", kind: "agent" } as any,
      model: { provider: "test", id: "test" },
      thinkingLevel: "medium",
      contractId: "phx_test",
      backend: "sdk",
      pi: this.pi,
      status: "running",
      startedAt: new Date().toISOString(),
    };
  }

  subscribe(_listener: (event: ChildSessionEvent) => void): () => void {
    return () => {};
  }

  async continue(_message: string, _signal?: AbortSignal): Promise<ChildCycleOutcome> {
    return { cycle: 1, status: "settled" };
  }

  async waitForCurrentCycle(_signal?: AbortSignal): Promise<ChildCycleOutcome> {
    return { cycle: 1, status: "settled" };
  }

  async abort(_reason: string): Promise<void> {
    this.abortCalls++;
  }

  async dispose(): Promise<void> {
    this.disposeCalls++;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ChildSessionRegistry", () => {
  let registry: ChildSessionRegistry;

  beforeEach(() => {
    registry = new ChildSessionRegistry();
  });

  it("add and get work correctly", () => {
    const run = new FakeChildRun(childRunId("run-1"));
    const controller = new AbortController();
    const record = {
      run,
      completion: Promise.resolve({ ok: true, status: "completed" as const }),
      controller,
    };

    registry.add(record);
    assert.equal(registry.get(run.id), record);
  });

  it("get returns undefined for unknown id", () => {
    assert.equal(registry.get(childRunId("unknown")), undefined);
  });

  it("remove deletes the record", () => {
    const run = new FakeChildRun(childRunId("run-2"));
    const controller = new AbortController();
    const record = {
      run,
      completion: Promise.resolve({ ok: true, status: "completed" as const }),
      controller,
    };

    registry.add(record);
    registry.remove(run.id);
    assert.equal(registry.get(run.id), undefined);
  });

  it("list returns all records", () => {
    const run1 = new FakeChildRun(childRunId("run-a"));
    const run2 = new FakeChildRun(childRunId("run-b"));
    const controller = new AbortController();

    registry.add({
      run: run1,
      completion: Promise.resolve({ ok: true, status: "completed" as const }),
      controller,
    });
    registry.add({
      run: run2,
      completion: Promise.resolve({ ok: true, status: "completed" as const }),
      controller,
    });

    assert.equal(registry.list().length, 2);
  });

  it("shutdown aborts and disposes all active runs", async () => {
    const run1 = new FakeChildRun(childRunId("s1"));
    const run2 = new FakeChildRun(childRunId("s2"));
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    registry.add({
      run: run1,
      completion: new Promise(() => {}),
      controller: controller1,
    });
    registry.add({
      run: run2,
      completion: new Promise(() => {}),
      controller: controller2,
    });

    await registry.shutdown("test shutdown");

    assert.equal(run1.abortCalls, 1);
    assert.equal(run1.disposeCalls, 1);
    assert.equal(run2.abortCalls, 1);
    assert.equal(run2.disposeCalls, 1);
    assert.equal(registry.list().length, 0);
  });

  it("shutdown is safe with no active runs", async () => {
    await registry.shutdown("empty shutdown");
    assert.equal(registry.list().length, 0);
  });
});

describe("ChildSessionRegistry singleton", () => {
  it("getChildSessionRegistry returns a registry", () => {
    resetChildSessionRegistry();
    const registry = getChildSessionRegistry();
    assert.ok(registry);
    // Same instance on subsequent calls
    assert.equal(getChildSessionRegistry(), registry);
  });

  it("resetChildSessionRegistry creates a new instance", () => {
    const first = getChildSessionRegistry();
    resetChildSessionRegistry();
    const second = getChildSessionRegistry();
    assert.notEqual(first, second);
  });
});
