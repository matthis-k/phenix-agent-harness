import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { ObservabilityTheme } from "../extension/observability-theme.ts";
import { stripTranscriptAnsi } from "../extension/workspace/transcript-selection.ts";
import { editorBody, renderWorkspaceComposer } from "../extension/workspace/workspace-composer.ts";

const THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => `\x1b[40m${text}\x1b[49m`,
  bold: (text: string) => text,
} as unknown as ObservabilityTheme;

test("removes the editor rules before composing the surfaced input box", () => {
  assert.deepEqual(editorBody(["────────", "message", "────────"]), ["message"]);
  assert.deepEqual(editorBody(["message"]), ["message"]);
});

test("renders a focused input surface without persistent key hints", () => {
  const lines = renderWorkspaceComposer({
    lines: ["────────", "hello", "────────"],
    width: 72,
    active: true,
    theme: THEME,
  });

  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => visibleWidth(line) === 72));
  const plain = lines.map(stripTranscriptAnsi).join("\n");
  assert.match(plain, /hello/);
  assert.doesNotMatch(plain, /base|free|D1/);
  assert.doesNotMatch(plain, /tab|pgup|pgdn|native keys preserved/i);
  assert.doesNotMatch(plain, /────────/);
});

test("grows on the first newline and keeps one row on both sides of input", () => {
  const singleLine = renderWorkspaceComposer({
    lines: ["────────", "first", "────────"],
    width: 40,
    active: true,
    theme: THEME,
  });
  const twoLines = renderWorkspaceComposer({
    lines: ["────────", "first", "second", "────────"],
    width: 40,
    active: true,
    theme: THEME,
  });

  assert.equal(singleLine.length, 3);
  assert.equal(twoLines.length, 4);
  assert.match(stripTranscriptAnsi(twoLines[1] ?? ""), /first/);
  assert.match(stripTranscriptAnsi(twoLines[2] ?? ""), /second/);
  assert.ok(isBlankComposerRow(twoLines.at(-1) ?? ""));
});

function isBlankComposerRow(line: string): boolean {
  return stripTranscriptAnsi(line).replace(/[┃│]/gu, "").trim().length === 0;
}
