import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
  defaultRoutingPolicy,
  PhenixModelResolver,
} from "../adapters/routing/phenix-model-resolver.ts";
import { PiModelInventory } from "../adapters/routing/pi-model-inventory.ts";

test("registered OpenCode free models are usable without configured auth", () => {
  const registry = freeModelRegistry();
  const inventory = new PiModelInventory(registry);
  const available = inventory.available();
  const configured = defaultRoutingPolicy.candidates("free", "general");

  assert.deepEqual(available, configured);
  const candidate = available[0];
  assert.ok(candidate);
  assert.equal(candidate.backend, "pi");
  assert.equal(inventory.contains(candidate), true);
});

test("phenix/free resolves a registered anonymous OpenCode model", async () => {
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

  assert.equal(resolved.target.backend, "pi");
  assert.equal(resolved.concrete.provider, "opencode");
  assert.match(resolved.concrete.model, /-free$/);
});

test("registered paid models still require configured auth", () => {
  const registry = {
    getAvailable: () => [],
    find: (provider: string, model: string) => ({ provider, id: model }),
  } as unknown as ModelRegistry;
  const inventory = new PiModelInventory(registry);

  assert.equal(
    inventory.contains({ backend: "pi", provider: "opencode", model: "some-paid-model" }),
    false,
  );
  assert.equal(
    inventory.contains({ backend: "pi", provider: "openai-codex", model: "gpt-5.6" }),
    false,
  );
  assert.equal(
    inventory.contains({ backend: "claude", provider: "anthropic", model: "sonnet" }),
    false,
  );
});

function freeModelRegistry(): ModelRegistry {
  return {
    getAvailable: () => [],
    find: (provider: string, model: string) =>
      provider === "opencode" && model.endsWith("-free") ? { provider, id: model } : undefined,
  } as unknown as ModelRegistry;
}
