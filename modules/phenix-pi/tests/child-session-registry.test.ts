/** Managed subagent registry tests. */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  ChildSessionRegistry,
  getChildSessionRegistry,
  resetChildSessionRegistry,
} from "../extensions/phenix-runtime/child-session-registry.ts";
import type {
  SubagentCancellation,
  SubagentEvent,
  SubagentHandle,
  SubagentSnapshot,
} from "../extensions/phenix-runtime/subagent-manager.ts";

class FakeManagedHandle implements SubagentHandle<unknown> {
  readonly id: string;
  readonly cancellations: Array<string | SubagentCancellation | undefined> = [];

  constructor(id: string) {
    this.id = id;
  }

  snapshot(): SubagentSnapshot {
    return { id: this.id, status: "running" };
  }

  poll(): Promise<SubagentSnapshot> {
    return Promise.resolve(this.snapshot());
  }

  result(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  send(_message: string, _signal?: AbortSignal): Promise<void> {
    return Promise.resolve();
  }

  cancel(cancellation?: string | SubagentCancellation): Promise<void> {
    this.cancellations.push(cancellation);
    return Promise.resolve();
  }

  subscribe(_listener: (event: SubagentEvent) => void): () => void {
    return () => {};
  }
}

describe("ChildSessionRegistry", () => {
  let registry: ChildSessionRegistry;

  beforeEach(() => {
    registry = new ChildSessionRegistry();
  });

  it("add and get work correctly", () => {
    const handle = new FakeManagedHandle("run-1");
    const record = {
      handle,
      completion: Promise.resolve(undefined),
    };

    registry.add(record);
    assert.equal(registry.get(handle.id), record);
  });

  it("get returns undefined for unknown id", () => {
    assert.equal(registry.get("unknown"), undefined);
  });

  it("remove deletes the record", () => {
    const handle = new FakeManagedHandle("run-2");
    const record = {
      handle,
      completion: Promise.resolve(undefined),
    };

    registry.add(record);
    registry.remove(handle.id);
    assert.equal(registry.get(handle.id), undefined);
  });

  it("list returns all records", () => {
    registry.add({
      handle: new FakeManagedHandle("run-a"),
      completion: Promise.resolve(undefined),
    });
    registry.add({
      handle: new FakeManagedHandle("run-b"),
      completion: Promise.resolve(undefined),
    });

    assert.equal(registry.list().length, 2);
  });

  it("shutdown cancels all active managed handles", async () => {
    const first = new FakeManagedHandle("s1");
    const second = new FakeManagedHandle("s2");

    registry.add({ handle: first, completion: new Promise(() => {}) });
    registry.add({ handle: second, completion: new Promise(() => {}) });

    await registry.shutdown("test shutdown");

    assert.deepEqual(first.cancellations, ["test shutdown"]);
    assert.deepEqual(second.cancellations, ["test shutdown"]);
    assert.equal(registry.list().length, 0);
  });

  it("shutdown is safe with no active handles", async () => {
    await registry.shutdown("empty shutdown");
    assert.equal(registry.list().length, 0);
  });
});

describe("ChildSessionRegistry singleton", () => {
  it("getChildSessionRegistry returns one shared registry", () => {
    resetChildSessionRegistry();
    const registry = getChildSessionRegistry();
    assert.ok(registry);
    assert.equal(getChildSessionRegistry(), registry);
  });

  it("resetChildSessionRegistry creates a new instance", () => {
    const first = getChildSessionRegistry();
    resetChildSessionRegistry();
    const second = getChildSessionRegistry();
    assert.notEqual(first, second);
  });
});
