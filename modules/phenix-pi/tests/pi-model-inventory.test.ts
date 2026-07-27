import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { PhenixModelResolver } from "../adapters/routing/phenix-model-resolver.ts";
import { PiModelInventory } from "../adapters/routing/pi-model-inventory.ts";

test("the configured OpenCode free model is usable without configured auth", () => {
  const inventory = new PiModelInventory(freeModelRegistry());
  assert.equal(inventory.contains("opencode", "deepseek-v4-flash-free"), true);
});

test("phenix/free resolves the configured anonymous OpenCode model", async () => {
  const resolver = new PhenixModelResolver(new PiModelInventory(freeModelRegistry()));
  const resolved = await resolver.resolve(
    { kind: "virtual", provider: "phenix", model: "free" },
    {
      definitionId: "agent.base",
      parentDefinitionId: "root.session",
      thinking: "route",
      modelSet: "free",
      difficulty: "D1",
    },
  );

  assert.deepEqual(resolved.concrete, {
    kind: "concrete",
    provider: "opencode",
    model: "deepseek-v4-flash-free",
  });
});

test("registered paid models still require configured auth", () => {
  const registry = {
    getAvailable: () => [],
    find: (provider: string, model: string) => ({ provider, id: model }),
  } as unknown as ModelRegistry;
  const inventory = new PiModelInventory(registry);

  assert.equal(inventory.contains("opencode", "some-paid-model"), false);
  assert.equal(inventory.contains("openai-codex", "gpt-5.6-sol"), false);
});

function freeModelRegistry(): ModelRegistry {
  return {
    getAvailable: () => [],
    find: (provider: string, model: string) =>
      provider === "opencode" && model.endsWith("-free") ? { provider, id: model } : undefined,
  } as unknown as ModelRegistry;
}
