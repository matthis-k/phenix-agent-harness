import assert from "node:assert/strict";
import test from "node:test";

import {
  formatModelTarget,
  parseModelTarget,
  targetModel,
} from "../domain/definition/model.ts";

test("model targets round-trip as backend/provider/model", () => {
  const target = parseModelTarget("pi/openai/gpt-5.6-sol");
  assert.deepEqual(target, {
    backend: "pi",
    provider: "openai",
    model: "gpt-5.6-sol",
  });
  assert.equal(formatModelTarget(target), "pi/openai/gpt-5.6-sol");
});

test("model target parsing preserves backend-native model paths", () => {
  const target = parseModelTarget("acp/openai/organization/models/gpt-5.6-sol");
  assert.equal(target.backend, "acp");
  assert.equal(target.provider, "openai");
  assert.equal(target.model, "organization/models/gpt-5.6-sol");
});

test("target selectors carry the explicit backend", () => {
  assert.deepEqual(targetModel("claude", "anthropic", "sonnet"), {
    kind: "target",
    backend: "claude",
    provider: "anthropic",
    model: "sonnet",
  });
});

test("invalid target strings are rejected", () => {
  assert.throws(() => parseModelTarget("openai/gpt-5.6-sol"), /expected backend\/provider\/model/);
  assert.throws(() => parseModelTarget("pi//gpt-5.6-sol"), /expected backend\/provider\/model/);
});
