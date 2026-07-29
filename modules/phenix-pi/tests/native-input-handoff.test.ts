import assert from "node:assert/strict";
import test from "node:test";

import type { AppKeybinding, KeybindingsManager } from "@earendil-works/pi-coding-agent";

import { handoffNativeWorkspaceInput } from "../extension/workspace/native-input-handoff.ts";
import type { NativeInputDelegation } from "../extension/workspace/workspace-interaction.ts";

const KEY_ACTIONS: Readonly<Record<string, AppKeybinding>> = {
  "\x03": "app.clear",
  "\x07": "app.editor.external",
};
const KEYBINDINGS = {
  matches: (data: string, action: AppKeybinding) => KEY_ACTIONS[data] === action,
} as Pick<KeybindingsManager, "matches">;

test("resolves the native action before forwarding the same key", () => {
  let delegation: NativeInputDelegation | undefined;
  const result = handoffNativeWorkspaceInput({
    data: "\x07",
    keybindings: KEYBINDINGS,
    handoff: (next) => {
      delegation = next;
    },
  });

  assert.deepEqual(delegation, {
    action: "app.editor.external",
    reopenWorkspace: true,
  });
  assert.deepEqual(result, { data: "\x07" });
});

test("leaves unrelated input in the focused workspace", () => {
  let touched = false;
  const result = handoffNativeWorkspaceInput({
    data: "x",
    keybindings: KEYBINDINGS,
    handoff: () => {
      touched = true;
    },
  });

  assert.equal(result, undefined);
  assert.equal(touched, false);
});

test("a contextual action may stay in the workspace", () => {
  let touched = false;
  const result = handoffNativeWorkspaceInput({
    data: "\x03",
    keybindings: KEYBINDINGS,
    accept: (delegation) => delegation.action !== "app.clear",
    handoff: () => {
      touched = true;
    },
  });

  assert.equal(result, undefined);
  assert.equal(touched, false);
});
