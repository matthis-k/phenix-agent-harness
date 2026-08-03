import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceSourceChange } from "../application/workspace/frontend.ts";
import { runId } from "../domain/shared.ts";
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

test("workspace subscriptions distinguish snapshot and transcript changes", () => {
  const snapshotListeners: Array<() => void> = [];
  const transcriptListeners: Array<(changedRunId: ReturnType<typeof runId>) => void> = [];
  let disposals = 0;
  const snapshotSource = {
    subscribe(listener: () => void): () => void {
      snapshotListeners.push(listener);
      return () => {
        disposals += 1;
      };
    },
  };
  const transcriptSource = {
    subscribe(listener: (changedRunId: ReturnType<typeof runId>) => void): () => void {
      transcriptListeners.push(listener);
      return () => {
        disposals += 1;
      };
    },
  };
  const runtime = {
    events: snapshotSource,
    diagnostics: snapshotSource,
    transcripts: transcriptSource,
    projects: snapshotSource,
    userForms: snapshotSource,
    memory: snapshotSource,
  } as unknown as WorkspaceRuntimeBinding["runtime"];
  const changes: WorkspaceSourceChange[] = [];

  const dispose = subscribeWorkspaceChanges(runtime, (change) => {
    if (change) changes.push(change);
  });
  for (const listener of snapshotListeners) listener();
  for (const listener of transcriptListeners) listener(runId("child"));
  dispose();

  assert.deepEqual(changes, [
    { kind: "snapshot" },
    { kind: "snapshot" },
    { kind: "snapshot" },
    { kind: "snapshot" },
    { kind: "snapshot" },
    { kind: "transcript", runId: runId("child") },
  ]);
  assert.equal(disposals, 6);
});
