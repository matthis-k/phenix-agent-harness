import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { ManagedSubagentRegistry } from "../extensions/phenix-runtime/managed-subagent-registry.ts";
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

describe("ManagedSubagentRegistry", () => {
  let registry: ManagedSubagentRegistry;

  beforeEach(() => {
    registry = new ManagedSubagentRegistry();
  });

  it("stores handles by their public identifier", () => {
    const handle = new FakeManagedHandle("run-1");

    registry.add(handle);

    assert.equal(registry.get(handle.id), handle);
    assert.equal(registry.size, 1);
    assert.deepEqual(registry.list(), [handle]);
  });

  it("removes handles without affecting unrelated entries", () => {
    const first = new FakeManagedHandle("run-1");
    const second = new FakeManagedHandle("run-2");
    registry.add(first);
    registry.add(second);

    registry.remove(first.id);

    assert.equal(registry.get(first.id), undefined);
    assert.equal(registry.get(second.id), second);
    assert.equal(registry.size, 1);
  });

  it("shutdown clears the registry and cancels every active handle", async () => {
    const first = new FakeManagedHandle("run-1");
    const second = new FakeManagedHandle("run-2");
    registry.add(first);
    registry.add(second);

    await registry.shutdown("session shutdown");

    assert.deepEqual(first.cancellations, ["session shutdown"]);
    assert.deepEqual(second.cancellations, ["session shutdown"]);
    assert.equal(registry.size, 0);
  });
});
