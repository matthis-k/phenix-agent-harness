import assert from "node:assert/strict";
import test from "node:test";

import type { ObservabilityTheme } from "../extension/observability-theme.ts";
import { TranscriptSelectionSurface } from "../extension/workspace/transcript-selection-surface.ts";

const THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ObservabilityTheme;

test("input-sized selection frames support selection text and clearing", () => {
  const surface = new TranscriptSelectionSurface();
  surface.setFrame({
    bounds: { x: 2, y: 10, width: 20, height: 3 },
    offset: 0,
    lines: ["first line", "second line"],
  });

  assert.equal(surface.begin({ x: 3, y: 12 }), true);
  assert.equal(surface.update({ x: 9, y: 12 }), true);
  assert.equal(surface.end({ x: 9, y: 12 }), true);
  assert.equal(surface.selectedText(), "first ");
  assert.ok(surface.renderLine("first line", 0, 20, THEME));

  surface.clear();
  assert.equal(surface.selection, undefined);
  assert.equal(surface.selectedText(), undefined);
});
