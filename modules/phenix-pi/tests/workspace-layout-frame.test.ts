import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { containsRect, intersects, rect } from "../domain/workspace/geometry.ts";
import type { PaneId } from "../domain/workspace/state.ts";
import {
  composeWorkspaceTextFrame,
  computeWorkspaceDimensions,
  paneRect,
  solveWorkspaceLayout,
} from "../extension/workspace/workspace-layout-frame.ts";

const RESET_BACKGROUND = "\x1b[49m";

test("preserves the conversation-first responsive workspace dimensions", () => {
  assert.deepEqual(computeWorkspaceDimensions(120, 40), {
    width: 120,
    height: 40,
    sidebarVisible: true,
    sidebarWidth: 28,
    mainWidth: 91,
  });
  assert.deepEqual(computeWorkspaceDimensions(89, 40), {
    width: 89,
    height: 40,
    sidebarVisible: false,
    sidebarWidth: 0,
    mainWidth: 89,
  });
});

test("solves transcript, editor, and sidebar into one immutable frame", () => {
  const result = solveWorkspaceLayout({
    width: 120,
    height: 40,
    editorHeight: 4,
    sidebarRequested: true,
    revision: 8,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(paneRect(result.value, "transcript"), rect(0, 0, 91, 35));
  assert.deepEqual(paneRect(result.value, "editor"), rect(0, 36, 91, 4));
  assert.deepEqual(paneRect(result.value, "runs"), rect(92, 0, 28, 40));
  assert.deepEqual(result.value.focusOrder, ["transcript", "editor"]);
});

test("omits the sidebar without changing conversation ownership", () => {
  const result = solveWorkspaceLayout({
    width: 80,
    height: 24,
    editorHeight: 3,
    sidebarRequested: true,
    revision: 2,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(paneRect(result.value, "transcript"), rect(0, 0, 80, 20));
  assert.deepEqual(paneRect(result.value, "editor"), rect(0, 21, 80, 3));
  assert.equal(result.value.panes.has("runs"), false);
});

test("all solved frames stay bounded and non-overlapping", () => {
  for (let width = 42; width <= 180; width += 3) {
    for (let height = 9; height <= 60; height += 3) {
      for (const sidebarRequested of [false, true]) {
        const result = solveWorkspaceLayout({
          width,
          height,
          editorHeight: Math.max(1, height % 8),
          sidebarRequested,
          revision: width * 1000 + height,
        });
        assert.equal(result.ok, true);
        if (!result.ok) continue;
        const panes = [...result.value.panes.values()];
        for (const bounds of panes) {
          assert.equal(containsRect(result.value.terminal, bounds), true);
        }
        for (let left = 0; left < panes.length; left += 1) {
          for (let right = left + 1; right < panes.length; right += 1) {
            const leftPane = panes[left];
            const rightPane = panes[right];
            assert.ok(leftPane);
            assert.ok(rightPane);
            assert.equal(intersects(leftPane, rightPane), false);
          }
        }
      }
    }
  }
});

test("composes pane-local lines into exact terminal rows with isolated backgrounds", () => {
  const result = solveWorkspaceLayout({
    width: 12,
    height: 4,
    editorHeight: 1,
    sidebarRequested: false,
    revision: 4,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const outputs = new Map<PaneId, { readonly lines: readonly string[] }>([
    ["transcript", { lines: ["\x1b[41mone", "two"] }],
    ["editor", { lines: ["> input"] }],
  ]);
  const lines = composeWorkspaceTextFrame(result.value, outputs);
  assert.deepEqual(
    lines.map((line) => line.replaceAll(RESET_BACKGROUND, "").replace("\x1b[41m", "")),
    ["one         ", "two         ", "            ", "> input     "],
  );
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => line.startsWith(RESET_BACKGROUND)));
  assert.ok(lines.every((line) => line.endsWith(RESET_BACKGROUND)));
  assert.ok(lines.every((line) => visibleWidth(line) === 12));
  assert.ok(lines[0]?.includes("\x1b[41mone"));
});
