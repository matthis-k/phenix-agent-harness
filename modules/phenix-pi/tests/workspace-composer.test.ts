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

test("renders a larger background-backed composer with profile and navigation help", () => {
  const lines = renderWorkspaceComposer({
    lines: ["────────", "hello", "────────"],
    width: 72,
    active: true,
    sidebarVisible: true,
    profile: { agent: "base", modelSet: "free", difficulty: "D1" },
    theme: THEME,
  });

  assert.equal(lines.length, 5);
  assert.ok(lines.every((line) => visibleWidth(line) === 72));
  const plain = lines.map(stripTranscriptAnsi).join("\n");
  assert.match(plain, /hello/);
  assert.match(plain, /base · free · D1/);
  assert.match(plain, /tab main\/sidebar/);
  assert.match(plain, /native keys preserved/);
  assert.doesNotMatch(plain, /ctrl\+[ob] native|ctrl\+b sidebar/);
  assert.doesNotMatch(plain, /────────/);
});
