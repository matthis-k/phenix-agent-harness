import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileSelection,
  reduceWorkspace,
} from "../application/workspace/reducer.ts";
import { runId } from "../domain/shared.ts";
import type { WorkspaceItemIndex, WorkspaceSnapshotEnvelope } from "../domain/workspace/events.ts";
import type { EffectId, PaneId, WorkspaceState } from "../domain/workspace/state.ts";
import { createInitialWorkspaceState } from "../domain/workspace/state.ts";

const effectId = (value: string): EffectId => value as EffectId;
const PANES: readonly PaneId[] = ["transcript", "editor", "runs", "tasks", "files", "facts"];

test("stable selection survives insertions and reordering", () => {
  assert.equal(reconcileSelection("b", ["a", "b", "c"], ["c", "x", "b", "a"]), "b");
});

test("removed selection resolves to the nearest surviving former position", () => {
  assert.equal(reconcileSelection("b", ["a", "b", "c"], ["a", "c"]), "c");
  assert.equal(reconcileSelection("c", ["a", "b", "c"], ["a"]), "a");
  assert.equal(reconcileSelection(undefined, [], ["root", "child"]), "root");
  assert.equal(reconcileSelection("missing", ["a"], []), undefined);
});

test("snapshot completion reconciles every pane by stable ID", () => {
  const root = runId("root");
  let state = createInitialWorkspaceState(root);
  state = reduceWorkspace(state, {
    type: "selection.set",
    paneId: "tasks",
    itemId: "task-b",
  }).state;
  const requestId = effectId("snapshot-1");
  state = reduceWorkspace(state, { type: "snapshot.requested", requestId }).state;

  const received = reduceWorkspace(state, {
    type: "snapshot.received",
    requestId,
    previousItemIds: itemIndex({ tasks: ["task-a", "task-b", "task-c"], runs: ["root"] }),
    snapshot: snapshot(1, root, {
      tasks: ["task-c", "task-b", "task-a"],
      runs: ["root"],
    }),
  });

  assert.equal(received.state.panes.tasks.selectedItemId, "task-b");
  assert.equal(received.state.snapshotRevision, 1);
  assert.equal(received.state.pendingEffects.size, 0);
  assert.deepEqual(received.effects, []);
});

test("older and unknown snapshot completions cannot replace current state", () => {
  const root = runId("root");
  const requestId = effectId("snapshot-1");
  let state = createInitialWorkspaceState(root);
  state = reduceWorkspace(state, { type: "snapshot.requested", requestId }).state;
  state = reduceWorkspace(state, {
    type: "snapshot.received",
    requestId,
    previousItemIds: itemIndex({ runs: ["root"] }),
    snapshot: snapshot(5, root, { runs: ["root"] }),
  }).state;

  const staleRequest = effectId("snapshot-stale");
  state = reduceWorkspace(state, { type: "snapshot.requested", requestId: staleRequest }).state;
  const stale = reduceWorkspace(state, {
    type: "snapshot.received",
    requestId: staleRequest,
    previousItemIds: itemIndex({ runs: ["root"] }),
    snapshot: snapshot(4, root, { runs: ["root"] }),
  });

  assert.equal(stale.state.snapshotRevision, 5);
  assert.equal(stale.effects[0]?.type, "diagnostic.record");
  if (stale.effects[0]?.type === "diagnostic.record") {
    assert.equal(stale.effects[0].error.code, "stale-effect");
  }

  const unknown = reduceWorkspace(stale.state, {
    type: "snapshot.received",
    requestId: effectId("unknown"),
    previousItemIds: itemIndex(),
    snapshot: snapshot(6, root, { runs: ["root"] }),
  });
  assert.equal(unknown.state.snapshotRevision, 5);
  assert.equal(unknown.effects[0]?.type, "diagnostic.record");
});

test("focus cycles only through the supplied visible order", () => {
  const root = runId("root");
  let state = createInitialWorkspaceState(root);
  state = reduceWorkspace(state, {
    type: "focus.move",
    direction: 1,
    order: ["transcript", "editor", "runs"],
  }).state;
  assert.equal(state.focusedPaneId, "runs");

  state = reduceWorkspace(state, {
    type: "focus.move",
    direction: 1,
    order: ["transcript", "editor", "runs"],
  }).state;
  assert.equal(state.focusedPaneId, "transcript");
});

test("selecting a transcript resets viewport origin and supersedes prior loads", () => {
  const root = runId("root");
  const childA = runId("child-a");
  const childB = runId("child-b");
  let state = createInitialWorkspaceState(root);
  state = reduceWorkspace(state, {
    type: "scroll.set",
    paneId: "transcript",
    scroll: { mode: "fixed", offset: 12 },
  }).state;

  const first = effectId("transcript-1");
  state = reduceWorkspace(state, {
    type: "transcript.requested",
    requestId: first,
    runId: childA,
  }).state;
  const second = effectId("transcript-2");
  const update = reduceWorkspace(state, {
    type: "transcript.requested",
    requestId: second,
    runId: childB,
  });
  state = update.state;

  assert.equal(state.activeRunId, childB);
  assert.equal(state.panes.runs.selectedItemId, childB);
  assert.deepEqual(state.transcript.scroll, { mode: "follow-end" });
  assert.deepEqual(state.panes.transcript.scroll, { mode: "follow-end" });
  assert.equal(state.transcript.horizontalOrigin, 0);
  assert.equal(state.pendingEffects.has(first), false);
  assert.equal(state.pendingEffects.has(second), true);
  assert.deepEqual(update.effects, [
    {
      type: "transcript.load",
      requestId: second,
      sourceRevision: state.revision - 1,
      runId: childB,
    },
  ]);
});

test("late transcript completion cannot replace the selected run", () => {
  const root = runId("root");
  const childA = runId("child-a");
  const childB = runId("child-b");
  const first = effectId("transcript-1");
  const second = effectId("transcript-2");
  let state = createInitialWorkspaceState(root);
  state = reduceWorkspace(state, {
    type: "transcript.requested",
    requestId: first,
    runId: childA,
  }).state;
  state = reduceWorkspace(state, {
    type: "transcript.requested",
    requestId: second,
    runId: childB,
  }).state;

  const late = reduceWorkspace(state, {
    type: "transcript.loaded",
    requestId: first,
    runId: childA,
    handle: { key: "old" },
  });
  assert.equal(late.state.transcript.runId, childB);
  assert.equal(late.state.transcript.availability.kind, "pending");
  assert.equal(late.effects[0]?.type, "diagnostic.record");

  const current = reduceWorkspace(late.state, {
    type: "transcript.loaded",
    requestId: second,
    runId: childB,
    handle: { key: "current" },
  });
  assert.deepEqual(current.state.transcript.availability, {
    kind: "ready",
    transcript: { key: "current" },
  });
});

test("semantic transcript scrolling never uses numeric sentinels", () => {
  const root = runId("root");
  let state = createInitialWorkspaceState(root);
  state = reduceWorkspace(state, {
    type: "scroll.by",
    paneId: "transcript",
    rows: -3,
  }).state;
  assert.deepEqual(state.transcript.scroll, { mode: "fixed", offset: 3 });
  assert.deepEqual(state.panes.transcript.scroll, state.transcript.scroll);

  state = reduceWorkspace(state, { type: "scroll.end", paneId: "transcript" }).state;
  assert.deepEqual(state.transcript.scroll, { mode: "follow-end" });
  assert.equal(JSON.stringify(state).includes(String(Number.MAX_SAFE_INTEGER)), false);
});

function snapshot(
  revision: number,
  rootRunId: ReturnType<typeof runId>,
  items: Partial<WorkspaceItemIndex>,
): WorkspaceSnapshotEnvelope<{ readonly label: string }> {
  return {
    revision,
    rootRunId,
    itemIds: itemIndex(items),
    value: { label: `snapshot-${revision}` },
  };
}

function itemIndex(items: Partial<WorkspaceItemIndex> = {}): WorkspaceItemIndex {
  return Object.fromEntries(
    PANES.map((paneId) => [paneId, items[paneId] ?? []]),
  ) as WorkspaceItemIndex;
}
