import assert from "node:assert/strict";
import test from "node:test";

import { rect } from "../domain/workspace/geometry.ts";
import {
  selectedTranscriptText,
  transcriptSelectionColumns,
} from "../extension/workspace/transcript-selection.ts";
import { TranscriptSelectionSurface } from "../extension/workspace/transcript-selection-surface.ts";

test("copies single-line and multiline transcript ranges", () => {
  const lines = ["first line", "second line", "third line"];

  assert.equal(
    selectedTranscriptText(lines, {
      anchor: { row: 0, column: 2 },
      focus: { row: 0, column: 7 },
    }),
    "rst l",
  );
  assert.equal(
    selectedTranscriptText(lines, {
      anchor: { row: 0, column: 6 },
      focus: { row: 2, column: 5 },
    }),
    "line\nsecond line\nthird",
  );
});

test("normalizes reverse selections and exposes row-local highlight columns", () => {
  const selection = {
    anchor: { row: 2, column: 4 },
    focus: { row: 0, column: 3 },
  };

  assert.deepEqual(transcriptSelectionColumns(selection, 0, "abcdef"), [3, 6]);
  assert.deepEqual(transcriptSelectionColumns(selection, 1, "abcdef"), [0, 6]);
  assert.deepEqual(transcriptSelectionColumns(selection, 2, "abcdef"), [0, 4]);
  assert.equal(selectedTranscriptText(["abcdef", "ghijkl", "mnopqr"], selection), "def\nghijkl\nmnop");
});

test("dragging beyond transcript bounds clamps selection without including sidebar content", () => {
  const surface = new TranscriptSelectionSurface();
  surface.setFrame({
    bounds: rect(0, 0, 10, 4),
    offset: 0,
    lines: ["alpha", "beta", "gamma"],
  });

  assert.equal(surface.begin({ x: 2, y: 2 }), true);
  assert.equal(surface.update({ x: 80, y: 20 }), true);
  assert.equal(surface.end({ x: 80, y: 20 }), true);
  assert.equal(surface.selectedText(), "lpha\nbeta\ngamma");
});

test("clicks outside the transcript body do not start text selection", () => {
  const surface = new TranscriptSelectionSurface();
  surface.setFrame({
    bounds: rect(0, 0, 10, 4),
    offset: 0,
    lines: ["alpha", "beta", "gamma"],
  });

  assert.equal(surface.begin({ x: 15, y: 2 }), false);
  assert.equal(surface.begin({ x: 2, y: 1 }), false);
  assert.equal(surface.selection, undefined);
});
