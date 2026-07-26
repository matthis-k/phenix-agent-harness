import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { PiModelInventory } from "../adapters/routing/pi-model-inventory.ts";

test("registered OpenCode free models are usable without configured auth", () => {
  const registry = {
    getAvailable: () => [],
    find: (provider: string, model: string) =>
      provider === "opencode" && model.endsWith("-free") ? { provider, id: model } : undefined,
  } as unknown as ModelRegistry;
  const inventory = new PiModelInventory(registry);
  const available = inventory.available();

  assert.ok(available.length > 0);
  assert.ok(available.every((model) => model.provider === "opencode" && model.model.endsWith("-free")));
  const candidate = available[0];
  assert.ok(candidate);
  assert.equal(inventory.contains(candidate.provider, candidate.model), true);
});

test("registered paid models still require configured auth", () => {
  const registry = {
    getAvailable: () => [],
    find: (provider: string, model: string) => ({ provider, id: model }),
  } as unknown as ModelRegistry;
  const inventory = new PiModelInventory(registry);

  assert.equal(inventory.contains("opencode", "some-paid-model"), false);
  assert.equal(inventory.contains("openai-codex", "gpt-5.6"), false);
});
