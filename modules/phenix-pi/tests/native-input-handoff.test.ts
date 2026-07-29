import assert from "node:assert/strict";
import test from "node:test";

import {
  handoffNativeWorkspaceInput,
  type NativeWorkspaceHandoffAction,
} from "../extension/workspace/native-input-handoff.ts";

test("closes the workspace before forwarding the same native key", () => {
  const calls: string[] = [];
  let action: NativeWorkspaceHandoffAction | undefined;
  const result = handoffNativeWorkspaceInput({
    data: "\x07",
    workspace: {
      getEditorText: () => "draft prompt",
      resolveNativeInputDelegation: () => ({
        action: "app.editor.external",
        reopenWorkspace: true,
      }),
    },
    setNativeEditorText: (text) => calls.push(`set:${text}`),
    closeWorkspace: (next) => {
      calls.push("close");
      action = next;
    },
  });

  assert.deepEqual(calls, ["set:draft prompt", "close"]);
  assert.deepEqual(action, {
    kind: "native",
    text: "draft prompt",
    reopenWorkspace: true,
  });
  assert.deepEqual(result, { data: "\x07" });
});

test("leaves unrelated input in the focused workspace", () => {
  let touched = false;
  const result = handoffNativeWorkspaceInput({
    data: "x",
    workspace: {
      getEditorText: () => "draft",
      resolveNativeInputDelegation: () => undefined,
    },
    setNativeEditorText: () => {
      touched = true;
    },
    closeWorkspace: () => {
      touched = true;
    },
  });

  assert.equal(result, undefined);
  assert.equal(touched, false);
});
