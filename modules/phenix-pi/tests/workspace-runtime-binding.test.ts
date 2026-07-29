import assert from "node:assert/strict";
import test from "node:test";

import {
  clearWorkspaceRuntime,
  publishWorkspaceRuntime,
  subscribeWorkspaceChanges,
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
  type WorkspaceRuntimeEventBus,
} from "../extension/workspace-runtime-binding.ts";

class TestEventBus implements WorkspaceRuntimeEventBus {
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  on(event: string, listener: (value: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function binding(rootRunId: string): WorkspaceRuntimeBinding {
  return {
    runtime: {} as WorkspaceRuntimeBinding["runtime"],
    rootRunId: rootRunId as WorkspaceRuntimeBinding["rootRunId"],
    integrations: "healthy",
  };
}

test("propagates runtime readiness across extension entry points through Pi events", () => {
  const events = new TestEventBus();
  const received: Array<WorkspaceRuntimeBinding | undefined> = [];
  subscribeWorkspaceRuntime(events, (value) => received.push(value));

  const ready = binding("root-session");
  publishWorkspaceRuntime(events, ready);
  clearWorkspaceRuntime(events, ready.rootRunId);

  assert.deepEqual(received, [ready, undefined]);
});

test("ignores stale clears and malformed shared events", () => {
  const events = new TestEventBus();
  const received: Array<WorkspaceRuntimeBinding | undefined> = [];
  subscribeWorkspaceRuntime(events, (value) => received.push(value));

  const ready = binding("root-current");
  publishWorkspaceRuntime(events, ready);
  clearWorkspaceRuntime(events, "root-stale" as WorkspaceRuntimeBinding["rootRunId"]);
  events.emit("phenix:workspace-runtime", { kind: "ready", binding: null });

  assert.deepEqual(received, [ready]);
});

test("workspace views subscribe and dispose all changing runtime projections together", () => {
  const listeners: Array<() => void> = [];
  let disposals = 0;
  const source = {
    subscribe(listener: () => void): () => void {
      listeners.push(listener);
      return () => {
        disposals += 1;
      };
    },
  };
  const ready = {
    runtime: {
      events: source,
      diagnostics: source,
      transcripts: source,
    } as unknown as WorkspaceRuntimeBinding["runtime"],
    rootRunId: "root-current" as WorkspaceRuntimeBinding["rootRunId"],
    integrations: "healthy",
  };
  let notifications = 0;

  const dispose = subscribeWorkspaceChanges(ready, () => {
    notifications += 1;
  });
  for (const listener of listeners) listener();
  dispose();

  assert.equal(notifications, 3);
  assert.equal(disposals, 3);
});
