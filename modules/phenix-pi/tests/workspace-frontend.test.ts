import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceFrontend,
  type WorkspaceFrontendChange,
  type WorkspaceSourceListener,
} from "../application/workspace/frontend.ts";
import { type RunId, runId } from "../domain/shared.ts";
import type { WorkspaceItemIndex, WorkspaceSnapshotEnvelope } from "../domain/workspace/events.ts";
import {
  WORKSPACE_SURFACE_IDS,
  WORKSPACE_SURFACES,
  workspaceSurface,
} from "../domain/workspace/surfaces.ts";
import type { ReadyWorkspaceTranscript } from "../ports/workspace-effects.ts";

const ROOT = runId("root");
const CHILD = runId("child");

interface TestSnapshot {
  readonly revision: number;
  readonly runs: readonly RunId[];
}

test("frontend publishes surface-scoped changes for independent hosts", () => {
  const initial = snapshot(1, [ROOT, CHILD]);
  const frontend = new WorkspaceFrontend({
    initialSnapshot: initial,
    initialTranscript: transcript("root", "root"),
    loadSnapshot: async () => initial,
    loadTranscript: async (runIdValue) => transcript(String(runIdValue), String(runIdValue)),
    subscribeSource: () => () => undefined,
  });
  const changes: WorkspaceFrontendChange[] = [];
  frontend.subscribe((change) => changes.push(change));

  frontend.dispatch({ type: "focus.set", paneId: "runs" });
  const focusChange = lastChange(changes);
  assert.deepEqual([...focusChange.dirtySurfaces], ["editor", "runs"]);
  assert.equal(focusChange.layoutChanged, false);

  frontend.dispatch({ type: "sidebar.toggle" });
  const sidebarChange = lastChange(changes);
  assert.deepEqual([...sidebarChange.dirtySurfaces], WORKSPACE_SURFACE_IDS);
  assert.equal(sidebarChange.layoutChanged, true);
  frontend.dispose();
});

test("snapshot changes invalidate components without discarding browsed selection", async () => {
  let current = snapshot(1, [ROOT, CHILD]);
  let publish: WorkspaceSourceListener = (): void => undefined;
  const frontend = new WorkspaceFrontend({
    initialSnapshot: current,
    initialTranscript: transcript("root-1", "root-1"),
    loadSnapshot: async () => current,
    loadTranscript: async (runIdValue) => transcript(String(runIdValue), String(runIdValue)),
    subscribeSource: (listener) => {
      publish = listener;
      return () => undefined;
    },
  });
  const changes: WorkspaceFrontendChange[] = [];
  frontend.subscribe((change) => changes.push(change));
  frontend.dispatch({ type: "selection.set", paneId: "runs", itemId: String(CHILD) });

  current = snapshot(2, [ROOT, CHILD]);
  publish({ kind: "snapshot" });
  await frontend.whenIdle();

  assert.equal(frontend.state.activeRunId, ROOT);
  assert.equal(frontend.state.panes.runs.selectedItemId, CHILD);
  assert.ok(
    changes.some((change) =>
      WORKSPACE_SURFACE_IDS.every((surfaceId) => change.dirtySurfaces.has(surfaceId)),
    ),
  );
  frontend.dispose();
});

test("transcript changes reload only the active transcript", async () => {
  const initial = snapshot(1, [ROOT, CHILD]);
  let publish: WorkspaceSourceListener = (): void => undefined;
  let snapshotLoads = 0;
  const transcriptLoads: RunId[] = [];
  const frontend = new WorkspaceFrontend({
    initialSnapshot: initial,
    initialTranscript: transcript("root", "root"),
    loadSnapshot: async () => {
      snapshotLoads += 1;
      return initial;
    },
    loadTranscript: async (runIdValue) => {
      transcriptLoads.push(runIdValue);
      return transcript(`transcript-${transcriptLoads.length}`, String(runIdValue));
    },
    subscribeSource: (listener) => {
      publish = listener;
      return () => undefined;
    },
  });
  const changes: WorkspaceFrontendChange[] = [];
  frontend.subscribe((change) => changes.push(change));

  frontend.selectTranscript(CHILD);
  await frontend.whenIdle();
  const refreshChangeStart = changes.length;
  transcriptLoads.length = 0;

  publish({ kind: "transcript", runId: ROOT });
  await frontend.whenIdle();
  assert.equal(snapshotLoads, 0);
  assert.deepEqual(transcriptLoads, []);
  assert.deepEqual(changes.slice(refreshChangeStart), []);

  publish({ kind: "transcript", runId: CHILD });
  await frontend.whenIdle();
  const transcriptChanges = changes.slice(refreshChangeStart);
  assert.equal(snapshotLoads, 0);
  assert.deepEqual(transcriptLoads, [CHILD]);
  assert.ok(transcriptChanges.length > 0);
  assert.ok(
    transcriptChanges.every(
      (change) =>
        change.dirtySurfaces.size === 1 &&
        change.dirtySurfaces.has("transcript") &&
        !change.layoutChanged,
    ),
  );
  frontend.dispose();
});

test("surface registry exposes one constrained component contract per pane", () => {
  assert.deepEqual(
    WORKSPACE_SURFACES.map((surface) => surface.id),
    WORKSPACE_SURFACE_IDS,
  );
  assert.equal(new Set(WORKSPACE_SURFACES.map((surface) => surface.id)).size, 7);
  assert.equal(workspaceSurface("transcript").constraints.overflow, "scroll");
  assert.equal(workspaceSurface("editor").role, "input");
  assert.equal(workspaceSurface("memory").constraints.collapsePriority, 30);
  assert.equal(workspaceSurface("facts").constraints.collapsePriority, 50);
});

function lastChange(changes: readonly WorkspaceFrontendChange[]): WorkspaceFrontendChange {
  const change = changes.at(-1);
  assert.ok(change);
  return change;
}

function snapshot(
  revision: number,
  runs: readonly RunId[],
): WorkspaceSnapshotEnvelope<TestSnapshot> {
  const itemIds: WorkspaceItemIndex = {
    transcript: [],
    editor: [],
    runs: runs.map(String),
    objectives: [],
    memory: [],
    files: [],
    facts: [],
  };
  return {
    revision,
    rootRunId: ROOT,
    itemIds,
    value: { revision, runs },
  };
}

function transcript(value: string, key: string): ReadyWorkspaceTranscript<string> {
  return { kind: "ready", handle: { key }, value };
}
