import assert from "node:assert/strict";
import test from "node:test";

import type { AppKeybinding, KeybindingsManager } from "@earendil-works/pi-coding-agent";

import {
  nextWorkspaceSection,
  resolveNativeInputDelegation,
  resolveWorkspaceInput,
  WORKSPACE_COPY_TRANSCRIPT,
  WORKSPACE_NATIVE_HANDOFF,
} from "../extension/workspace/workspace-interaction.ts";

const KEY_ACTIONS: Readonly<Record<string, AppKeybinding>> = {
  "\x04": "app.exit",
  "\x07": "app.editor.external",
  "\x0c": "app.model.select",
  "\x0f": "app.tools.expand",
  "\x1b": "app.interrupt",
  "\x1b[Z": "app.thinking.cycle",
  follow: "app.message.followUp",
  dequeue: "app.message.dequeue",
};
const KEYBINDINGS = {
  matches: (data: string, action: AppKeybinding) => KEY_ACTIONS[data] === action,
} as Pick<KeybindingsManager, "matches">;

test("main input keeps arrows and ordinary typing in the editor", () => {
  assert.deepEqual(resolveWorkspaceInput("\x1b[A", "main"), { kind: "editor" });
  assert.deepEqual(resolveWorkspaceInput("\x1b[B", "main"), { kind: "editor" });
  assert.deepEqual(resolveWorkspaceInput("j", "main"), { kind: "editor" });
  assert.deepEqual(resolveWorkspaceInput("hello", "main"), { kind: "editor" });
});

test("main input reserves only paging and plain Tab for workspace navigation", () => {
  assert.deepEqual(resolveWorkspaceInput("\x1b[5~", "main"), {
    kind: "transcript-page",
    direction: -1,
  });
  assert.deepEqual(resolveWorkspaceInput("\x1b[6~", "main"), {
    kind: "transcript-page",
    direction: 1,
  });
  assert.deepEqual(resolveWorkspaceInput("\t", "main"), { kind: "focus-toggle" });
  assert.deepEqual(resolveWorkspaceInput("\x1b[Z", "main"), { kind: "editor" });
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

test("workspace owns Ctrl+O while other native shortcuts remain delegated", () => {
  assert.deepEqual(resolveWorkspaceInput("\x0f", "main"), { kind: "thinking-toggle" });
  assert.deepEqual(resolveWorkspaceInput("\x02", "main"), { kind: "editor" });
  assert.equal(resolveNativeInputDelegation("\x0f", KEYBINDINGS), undefined);
  assert.deepEqual(resolveNativeInputDelegation("\x07", KEYBINDINGS), {
    action: "app.editor.external",
    reopenWorkspace: true,
  });
  assert.deepEqual(resolveNativeInputDelegation("\x1b[Z", KEYBINDINGS), {
    action: "app.thinking.cycle",
    reopenWorkspace: true,
  });
});

test("Escape clears transcript selection before retaining Pi interrupt semantics", () => {
  assert.equal(resolveNativeInputDelegation("\x1b", KEYBINDINGS, true), undefined);
  assert.deepEqual(resolveWorkspaceInput("\x1b", "main", true), {
    kind: "clear-selection",
  });
  assert.deepEqual(resolveWorkspaceInput("\x1b", "sidebar", true), {
    kind: "clear-selection",
  });
  assert.deepEqual(resolveNativeInputDelegation("\x1b", KEYBINDINGS), {
    action: "app.interrupt",
    reopenWorkspace: true,
  });
  assert.deepEqual(resolveNativeInputDelegation("follow", KEYBINDINGS), {
    action: "app.message.followUp",
    reopenWorkspace: true,
  });
  assert.deepEqual(resolveNativeInputDelegation("dequeue", KEYBINDINGS), {
    action: "app.message.dequeue",
    reopenWorkspace: true,
  });
});

test("Ctrl+D delegates native exit semantics to Pi", () => {
  assert.deepEqual(resolveNativeInputDelegation("\x04", KEYBINDINGS), {
    action: "app.exit",
    reopenWorkspace: false,
  });
});

test("native modal actions leave the workspace closed", () => {
  assert.deepEqual(resolveNativeInputDelegation("\x0c", KEYBINDINGS), {
    action: "app.model.select",
    reopenWorkspace: false,
  });
});

test("private handoff inputs do not occupy user shortcuts", () => {
  assert.deepEqual(resolveWorkspaceInput(WORKSPACE_NATIVE_HANDOFF, "main"), {
    kind: "native-ui",
  });
  assert.deepEqual(resolveWorkspaceInput(WORKSPACE_COPY_TRANSCRIPT, "main"), {
    kind: "copy-selection",
  });
});

test("raw Ctrl+C stays clear-or-exit while modifier-preserving Ctrl+Shift+C copies", () => {
  assert.deepEqual(resolveWorkspaceInput("\x03", "main", true), { kind: "clear-or-exit" });
  assert.deepEqual(resolveWorkspaceInput("\x03", "main", false), { kind: "clear-or-exit" });
  assert.deepEqual(resolveWorkspaceInput("\x1b[99;6u", "main"), { kind: "copy-selection" });
});

test("sidebar section navigation wraps in registry order", () => {
  const sections = ["runs", "tasks", "files", "facts"] as const;
  assert.equal(nextWorkspaceSection("runs", -1, sections), "facts");
  assert.equal(nextWorkspaceSection("facts", 1, sections), "runs");
  assert.equal(nextWorkspaceSection("tasks", 1, sections), "files");
});
