import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceController } from "../application/workspace/controller.ts";
import { type RunId, runId } from "../domain/shared.ts";
import type { WorkspaceError } from "../domain/workspace/errors.ts";
import type { WorkspaceItemIndex, WorkspaceSnapshotEnvelope } from "../domain/workspace/events.ts";
import { createInitialWorkspaceState } from "../domain/workspace/state.ts";
import type {
  LoadedWorkspaceTranscript,
  WorkspaceEffectRuntime,
} from "../ports/workspace-effects.ts";

interface SnapshotValue {
  readonly label: string;
}

interface TranscriptValue {
  readonly text: string;
}

const PANES = ["transcript", "editor", "runs", "objectives", "files", "facts"] as const;

test("uses an already-loaded transcript without scheduling an effect", () => {
  const root = runId("root");
  const runtime = new TestRuntime();
  const controller = new WorkspaceController({
    state: {
      ...createInitialWorkspaceState(root),
      transcript: {
        runId: root,
        availability: { kind: "ready", transcript: { key: "root-transcript" } },
        scroll: { mode: "follow-end" },
        horizontalOrigin: 0,
      },
    },
    runtime,
    transcript: {
      kind: "ready",
      handle: { key: "root-transcript" },
      value: { text: "root" },
    },
  });

  assert.deepEqual(controller.currentTranscript, { text: "root" });
  assert.equal(runtime.transcriptCalls.length, 0);
  assert.equal(controller.state.pendingEffects.size, 0);
});

test("coalesces refresh bursts into the current load plus one follow-up", async () => {
  const root = runId("root");
  const runtime = new TestRuntime();
  const controller = new WorkspaceController({
    state: createInitialWorkspaceState(root),
    runtime,
  });

  controller.invalidateSnapshot();
  controller.invalidateSnapshot();
  controller.invalidateSnapshot();
  assert.equal(runtime.snapshotCalls.length, 1);

  runtime.snapshotCalls[0]?.deferred.resolve(snapshot(1, root, "first"));
  await settle();
  assert.equal(runtime.snapshotCalls.length, 2);

  runtime.snapshotCalls[1]?.deferred.resolve(snapshot(2, root, "second"));
  await controller.whenIdle();

  assert.equal(runtime.snapshotCalls.length, 2);
  assert.equal(controller.snapshot?.revision, 2);
  assert.equal(controller.snapshot?.value.label, "second");
  assert.equal(controller.state.snapshotRevision, 2);
  assert.equal(controller.state.pendingEffects.size, 0);
});

test("publishes an accepted snapshot atomically with its state transition", async () => {
  const root = runId("root");
  const runtime = new TestRuntime();
  const controller = new WorkspaceController({
    state: createInitialWorkspaceState(root),
    runtime,
  });
  const observed: number[] = [];
  controller.subscribe(() => {
    if (controller.snapshot) observed.push(controller.snapshot.revision);
  });

  controller.invalidateSnapshot();
  runtime.snapshotCalls[0]?.deferred.resolve(snapshot(1, root, "ready"));
  await controller.whenIdle();

  assert.deepEqual(observed, [1]);
});

test("snapshot failure preserves the last valid snapshot and records a diagnostic", async () => {
  const root = runId("root");
  const runtime = new TestRuntime();
  const initial = snapshot(4, root, "stable");
  const controller = new WorkspaceController({
    state: { ...createInitialWorkspaceState(root), snapshotRevision: 4 },
    runtime,
    snapshot: initial,
  });

  controller.invalidateSnapshot();
  runtime.snapshotCalls[0]?.deferred.reject(new Error("storage unavailable"));
  await controller.whenIdle();

  assert.equal(controller.snapshot, initial);
  assert.equal(controller.state.snapshotRevision, 4);
  assert.equal(controller.state.pendingEffects.size, 0);
  assert.equal(runtime.diagnostics.at(-1)?.code, "snapshot-load-failed");
});

test("a newer transcript selection aborts and supersedes the older load", async () => {
  const root = runId("root");
  const childA = runId("child-a");
  const childB = runId("child-b");
  const runtime = new TestRuntime();
  const controller = new WorkspaceController({
    state: createInitialWorkspaceState(root),
    runtime,
  });

  controller.selectTranscript(childA);
  controller.selectTranscript(childB);
  assert.equal(runtime.transcriptCalls.length, 2);
  assert.equal(runtime.transcriptCalls[0]?.signal.aborted, true);

  runtime.transcriptCalls[0]?.deferred.resolve({
    kind: "ready",
    handle: { key: "child-a" },
    value: { text: "old" },
  });
  runtime.transcriptCalls[1]?.deferred.resolve({
    kind: "ready",
    handle: { key: "child-b" },
    value: { text: "current" },
  });
  await controller.whenIdle();

  assert.equal(controller.state.activeRunId, childB);
  assert.equal(controller.state.pendingEffects.size, 0);
  assert.deepEqual(controller.currentTranscript, { text: "current" });
  assert.deepEqual(controller.state.transcript.scroll, { mode: "follow-end" });
  assert.equal(controller.state.transcript.horizontalOrigin, 0);
});

test("publishes typed unavailable transcript outcomes without caching a value", async () => {
  const root = runId("root");
  const child = runId("child");
  const runtime = new TestRuntime();
  const controller = new WorkspaceController({
    state: createInitialWorkspaceState(root),
    runtime,
  });

  controller.selectTranscript(child);
  runtime.transcriptCalls[0]?.deferred.resolve({ kind: "pending-persistence", runId: child });
  await controller.whenIdle();

  assert.deepEqual(controller.state.transcript.availability, {
    kind: "pending-persistence",
    runId: child,
  });
  assert.equal(controller.currentTranscript, undefined);
  assert.equal(controller.state.pendingEffects.size, 0);
});

test("dispose aborts owned effects and ignores their late completion", async () => {
  const root = runId("root");
  const child = runId("child");
  const runtime = new TestRuntime();
  const controller = new WorkspaceController({
    state: createInitialWorkspaceState(root),
    runtime,
  });
  let notifications = 0;
  controller.subscribe(() => {
    notifications += 1;
  });

  controller.selectTranscript(child);
  const beforeDispose = notifications;
  controller.dispose();
  assert.equal(runtime.transcriptCalls[0]?.signal.aborted, true);
  runtime.transcriptCalls[0]?.deferred.resolve({
    kind: "ready",
    handle: { key: "late" },
    value: { text: "late" },
  });
  await controller.whenIdle();

  assert.equal(controller.currentTranscript, undefined);
  assert.equal(notifications, beforeDispose);
});

class TestRuntime implements WorkspaceEffectRuntime<SnapshotValue, TranscriptValue> {
  readonly snapshotCalls: Array<{
    readonly signal: AbortSignal;
    readonly deferred: Deferred<WorkspaceSnapshotEnvelope<SnapshotValue>>;
  }> = [];
  readonly transcriptCalls: Array<{
    readonly runId: RunId;
    readonly signal: AbortSignal;
    readonly deferred: Deferred<LoadedWorkspaceTranscript<TranscriptValue>>;
  }> = [];
  readonly diagnostics: WorkspaceError[] = [];

  loadSnapshot(signal: AbortSignal): Promise<WorkspaceSnapshotEnvelope<SnapshotValue>> {
    const deferred = new Deferred<WorkspaceSnapshotEnvelope<SnapshotValue>>();
    this.snapshotCalls.push({ signal, deferred });
    return deferred.promise;
  }

  loadTranscript(
    childRunId: RunId,
    signal: AbortSignal,
  ): Promise<LoadedWorkspaceTranscript<TranscriptValue>> {
    const deferred = new Deferred<LoadedWorkspaceTranscript<TranscriptValue>>();
    this.transcriptCalls.push({ runId: childRunId, signal, deferred });
    return deferred.promise;
  }

  recordDiagnostic(error: WorkspaceError): void {
    this.diagnostics.push(error);
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function snapshot(
  revision: number,
  rootRunId: RunId,
  label: string,
): WorkspaceSnapshotEnvelope<SnapshotValue> {
  return {
    revision,
    rootRunId,
    itemIds: itemIndex({ runs: [rootRunId] }),
    value: { label },
  };
}

function itemIndex(items: Partial<WorkspaceItemIndex> = {}): WorkspaceItemIndex {
  return Object.fromEntries(
    PANES.map((paneId) => [paneId, items[paneId] ?? []]),
  ) as WorkspaceItemIndex;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
