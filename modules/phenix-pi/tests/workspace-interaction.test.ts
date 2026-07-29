import assert from "node:assert/strict";
import test from "node:test";

import {
  nextWorkspaceSection,
  resolveWorkspaceInput,
} from "../extension/workspace/workspace-interaction.ts";

test("main input keeps arrows and ordinary typing in the editor", () => {
  assert.deepEqual(resolveWorkspaceInput("\x1b[A", "main"), { kind: "editor" });
  assert.deepEqual(resolveWorkspaceInput("\x1b[B", "main"), { kind: "editor" });
  assert.deepEqual(resolveWorkspaceInput("j", "main"), { kind: "editor" });
  assert.deepEqual(resolveWorkspaceInput("hello", "main"), { kind: "editor" });
});

test("main input reserves only paging for transcript navigation", () => {
  assert.deepEqual(resolveWorkspaceInput("\x1b[5~", "main"), {
    kind: "transcript-page",
    direction: -1,
  });
  assert.deepEqual(resolveWorkspaceInput("\x1b[6~", "main"), {
    kind: "transcript-page",
    direction: 1,
  });
});

test("sidebar input uses hjkl and actions while routing other typing to the editor", () => {
  assert.deepEqual(resolveWorkspaceInput("h", "sidebar"), {
    kind: "sidebar-section",
    direction: -1,
  });
  assert.deepEqual(resolveWorkspaceInput("l", "sidebar"), {
    kind: "sidebar-section",
    direction: 1,
  });
  assert.deepEqual(resolveWorkspaceInput("k", "sidebar"), {
    kind: "sidebar-item",
    direction: -1,
  });
  assert.deepEqual(resolveWorkspaceInput("j", "sidebar"), {
    kind: "sidebar-item",
    direction: 1,
  });
  assert.deepEqual(resolveWorkspaceInput("\r", "sidebar"), { kind: "sidebar-activate" });
  assert.deepEqual(resolveWorkspaceInput(" ", "sidebar"), { kind: "sidebar-collapse" });
  assert.deepEqual(resolveWorkspaceInput("x", "sidebar"), { kind: "editor" });
});

test("tab switches focus groups and Ctrl+C copies only an existing transcript selection", () => {
  assert.deepEqual(resolveWorkspaceInput("\t", "main"), { kind: "focus-toggle" });
  assert.deepEqual(resolveWorkspaceInput("\x03", "main", true), { kind: "copy-selection" });
  assert.deepEqual(resolveWorkspaceInput("\x03", "main", false), { kind: "editor" });
});

test("sidebar section navigation wraps in registry order", () => {
  const sections = ["runs", "tasks", "files", "facts"] as const;
  assert.equal(nextWorkspaceSection("runs", -1, sections), "facts");
  assert.equal(nextWorkspaceSection("facts", 1, sections), "runs");
  assert.equal(nextWorkspaceSection("tasks", 1, sections), "files");
});
