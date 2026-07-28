import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../domain/workflow/checkpoint.ts", import.meta.url), "utf8");

test("workflow checkpoints do not carry a version discriminator", () => {
  assert.doesNotMatch(source, /readonly version:/);
  assert.doesNotMatch(source, /version:\s*\d+/);
  assert.doesNotMatch(source, /value\.version/);
});
