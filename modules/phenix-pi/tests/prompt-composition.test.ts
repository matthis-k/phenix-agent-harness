import assert from "node:assert/strict";
import test from "node:test";

import { composeManagedPrompt } from "../adapters/pi-sdk/prompt-composition.ts";

test("managed agents replace Pi's default prompt unless explicitly configured otherwise", () => {
  assert.deepEqual(composeManagedPrompt(undefined, "Role contract"), {
    systemPrompt: "Role contract",
  });
  assert.deepEqual(composeManagedPrompt("replace", "Role contract"), {
    systemPrompt: "Role contract",
  });
});

test("append-default preserves Pi's built-in prompt and appends only the Phenix contract", () => {
  const options = composeManagedPrompt("append-default", "Role contract");

  assert.equal(options.systemPrompt, undefined);
  assert.deepEqual(options.appendSystemPrompt, ["Role contract"]);
  assert.equal(options.systemPromptOverride?.("project replacement"), undefined);
});
