import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceFrontend,
  type WorkspaceFrontendChange,
} from "../application/workspace/frontend.ts";
import { runId, type RunId } from "../domain/shared.ts";
import type {
  WorkspaceItemIndex,
  WorkspaceSnapshotEnvelope,
} from "../domain/workspace/events.ts";
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
  assert.deepEqual([...changes.at(-1)!.dirtySurfaces], ["editor", "runs"]);
  assert.equal(changes.at(-1)!.layoutChanged, false);

  frontend.dispatch({ type: "sidebar.toggle" });
  assert.deepEqual([...changes.at(-1)!.dirtySurfaces], WORKSPACE_SURFACE_IDS);
  assert.equal(changes.at(-1)!.layoutChanged, true);
  frontend.dispose();
});

test("snapshot changes invalidate components without discarding browsed selection", async () => {
  let current = snapshot(1, [ROOT, CHILD]);
  let publish = (): void => undefined;
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
  publish();
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

test("surface registry exposes one constrained component contract per pane", () => {
  assert.deepEqual(
    WORKSPACE_SURFACES.map((surface) => surface.id),
    WORKSPACE_SURFACE_IDS,
  );
  assert.equal(new Set(WORKSPACE_SURFACES.map((surface) => surface.id)).size, 6);
  assert.equal(workspaceSurface("transcript").constraints.overflow, "scroll");
  assert.equal(workspaceSurface("editor").role, "input");
  assert.equal(workspaceSurface("facts").constraints.collapsePriority, 40);
});

function snapshot(
  revision: number,
  runs: readonly RunId[],
): WorkspaceSnapshotEnvelope<TestSnapshot> {
  const itemIds: WorkspaceItemIndex = {
    transcript: [],
    editor: [],
    runs: runs.map(String),
    tasks: [],
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
