import assert from "node:assert/strict";
import test from "node:test";

import { runId } from "../domain/shared.ts";
import {
  containsRect,
  intersection,
  intersects,
  point,
  rect,
} from "../domain/workspace/geometry.ts";
import {
  allocateSidebarSections,
  solveLayout,
  validateLayoutFrame,
  type LayoutNode,
} from "../domain/workspace/layout.ts";
import {
  composeFrame,
  hitTest,
  Surface,
  type RenderOutput,
} from "../domain/workspace/render.ts";
import {
  createInitialWorkspaceState,
  type PaneId,
  type ViewId,
} from "../domain/workspace/state.ts";

const view = (value: string): ViewId => value as ViewId;

test("geometry primitives preserve bounded rectangles", () => {
  const outer = rect(2, 3, 10, 8);
  const inner = rect(4, 5, 3, 2);
  const crossing = rect(10, 8, 5, 5);

  assert.equal(containsRect(outer, inner), true);
  assert.equal(intersects(outer, crossing), true);
  assert.deepEqual(intersection(outer, crossing), rect(10, 8, 2, 3));
  assert.equal(intersection(inner, rect(20, 20, 1, 1)), undefined);
  assert.throws(() => rect(0, 0, -1, 1), /must not be negative/);
});

test("initial workspace state separates focus, selection, active run, and scroll modes", () => {
  const root = runId("root-session");
  const state = createInitialWorkspaceState(root);

  assert.equal(state.activeRunId, root);
  assert.equal(state.focusedPaneId, "editor");
  assert.equal(state.panes.runs.selectedItemId, root);
  assert.deepEqual(state.panes.transcript.scroll, { mode: "follow-end" });
  assert.equal(state.transcript.horizontalOrigin, 0);
  assert.equal(state.pendingEffects.size, 0);
});

test("layout solver collapses lower-value panes before violating bounds", () => {
  const specification = defaultLayout();
  const result = solveLayout(specification, rect(0, 0, 70, 30), {
    revision: 7,
    flags: new Set(["sidebar"]),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.panes.has("transcript"), true);
  assert.equal(result.value.panes.has("editor"), true);
  assert.equal(result.value.panes.has("runs"), false);
  assert.deepEqual(result.value.collapsed, ["runs"]);
  assert.equal(validateLayoutFrame(result.value), undefined);
});

test("layout solver produces deterministic bounded non-overlapping frames", () => {
  const specification = defaultLayout();
  for (let width = 42; width <= 180; width += 7) {
    for (let height = 9; height <= 60; height += 5) {
      const input = rect(0, 0, width, height);
      const environment = {
        revision: width * 1000 + height,
        flags: new Set(["sidebar"]),
      };
      const first = solveLayout(specification, input, environment);
      const second = solveLayout(specification, input, environment);
      assert.deepEqual(first, second);
      if (!first.ok) continue;
      assert.equal(validateLayoutFrame(first.value), undefined);
      for (const bounds of first.value.panes.values()) {
        assert.equal(containsRect(input, bounds), true);
      }
      const panes = [...first.value.panes.values()];
      for (let left = 0; left < panes.length; left += 1) {
        for (let right = left + 1; right < panes.length; right += 1) {
          assert.equal(intersects(panes[left]!, panes[right]!), false);
        }
      }
    }
  }
});

test("sidebar allocation never exceeds the available rows", () => {
  const constraints = [
    { id: "runs", weight: 5, minRows: 4, collapsePriority: 0, collapsed: false },
    { id: "tasks", weight: 2, minRows: 3, collapsePriority: 20, collapsed: false },
    { id: "files", weight: 2, minRows: 3, collapsePriority: 30, collapsed: false },
    { id: "facts", weight: 3, minRows: 3, collapsePriority: 40, collapsed: false },
  ];

  for (let height = 0; height <= 80; height += 1) {
    const frames = allocateSidebarSections(height, constraints);
    assert.ok(frames.reduce((sum, frame) => sum + frame.height, 0) <= height);
    let nextStart = 0;
    for (const frame of frames) {
      assert.equal(frame.start, nextStart);
      nextStart += frame.height;
      if (frame.hidden) assert.equal(frame.height, 0);
    }
  }
});

test("surface writes and blits clip at their own bounds", () => {
  const parent = new Surface(5, 3);
  parent.writeText(0, -2, "abcd");
  parent.writeText(1, 3, "wxyz");
  const child = new Surface(3, 2);
  child.writeText(0, 0, "123");
  child.writeText(1, 0, "456");
  parent.blit(child, { x: 4, y: 2 });

  assert.deepEqual(parent.toLines(), ["cd   ", "   wx", "    1"]);
});

test("compositor bounds surfaces and ties hit testing to the layout revision", () => {
  const layout = solveLayout(
    {
      kind: "split",
      axis: "horizontal",
      gap: 0,
      children: [
        { node: pane("transcript"), weight: 1, min: 4 },
        { node: pane("runs"), weight: 1, min: 4 },
      ],
    },
    rect(0, 0, 8, 2),
    { revision: 12, flags: new Set() },
  );
  assert.equal(layout.ok, true);
  if (!layout.ok) return;

  const transcript = new Surface(4, 2);
  transcript.writeText(0, 0, "left");
  const runs = new Surface(4, 2);
  runs.writeText(0, 0, "runs");
  const outputs = new Map<PaneId, RenderOutput>([
    ["transcript", { surface: transcript, cursor: point(1, 0), hitRegions: [] }],
    [
      "runs",
      {
        surface: runs,
        hitRegions: [{ id: "root", bounds: rect(0, 0, 4, 1), action: "select-root" }],
      },
    ],
  ]);

  const composed = composeFrame(layout.value, outputs, "transcript");
  assert.deepEqual(composed.lines, ["leftruns", "        "]);
  assert.deepEqual(composed.cursor, { paneId: "transcript", x: 1, y: 0 });
  assert.equal(hitTest(composed.hitMap, 11, point(5, 0)), undefined);
  assert.equal(hitTest(composed.hitMap, 12, point(5, 0))?.id, "root");
  assert.deepEqual(composed.diagnostics, []);
});

function defaultLayout(): LayoutNode {
  return {
    kind: "split",
    axis: "horizontal",
    gap: 1,
    children: [
      {
        weight: 7,
        min: 42,
        node: {
          kind: "split",
          axis: "vertical",
          gap: 0,
          children: [
            { node: pane("transcript", 1, 4), weight: 1 },
            { node: pane("editor", 1, 3), weight: 0, min: 3, max: 3 },
          ],
        },
      },
      {
        weight: 3,
        min: 32,
        max: 42,
        node: {
          kind: "conditional",
          predicate: { kind: "flag", flag: "sidebar" },
          then: pane("runs", 32, 1, 100),
        },
      },
    ],
  };
}

function pane(
  paneId: PaneId,
  minWidth = 1,
  minHeight = 1,
  collapsePriority?: number,
): LayoutNode {
  return {
    kind: "pane",
    paneId,
    viewId: view(paneId),
    minWidth,
    minHeight,
    ...(collapsePriority === undefined ? {} : { collapsePriority }),
  };
}
