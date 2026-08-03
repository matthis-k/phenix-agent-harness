import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMemoryModelInstructions,
  MEMORY_MODEL_INSTRUCTIONS,
} from "../adapters/pi-sdk/memory-session-extension.ts";

test("exposes the reversible memory contract to models exactly once", () => {
  const prompt = appendMemoryModelInstructions("Base agent instructions");

  assert.match(prompt, /phenix_memory/);
  assert.match(prompt, /action=search/);
  assert.match(prompt, /action=read/);
  assert.match(prompt, /action=note/);
  assert.match(prompt, /action=set_status/);
  assert.match(prompt, /captured automatically/);
  assert.match(prompt, /Current user instructions.*outrank recalled notes/);
  assert.ok(prompt.endsWith(MEMORY_MODEL_INSTRUCTIONS));
  assert.equal(appendMemoryModelInstructions(prompt), prompt);
});
