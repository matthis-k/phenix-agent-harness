import assert from "node:assert/strict";
import test from "node:test";

import {
  clearWorkspaceRuntime,
  publishWorkspaceRuntime,
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
