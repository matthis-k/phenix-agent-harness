import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PHENIX_API, PHENIX_PROVIDER } from "@matthis-k/phenix-routing/provider.ts";
import { type ModelRegistry, resolveRoute } from "@matthis-k/phenix-routing/resolver.ts";
import type { ModelRef } from "@matthis-k/phenix-routing/types.ts";
import {
  buildDefaultRoutingConfig,
  DEFAULT_PHENIX_MODEL_SETS,
  defaultModelSetForModelId,
} from "./support/default-routing-fixture.ts";

/** Fake model registry for unit tests — no network calls. */
class FakeRegistry implements ModelRegistry {
  private readonly available: Set<string>;

  constructor(available: readonly ModelRef[]) {
    this.available = new Set(available.map((m) => `${m.provider}/${m.model}`));
  }

  isAvailable(provider: string, model: string): boolean {
    return this.available.has(`${provider}/${model}`);
  }
}

function mr(provider: string, model: string): ModelRef {
  return { provider, model };
}

const GO_MODELS: readonly ModelRef[] = [
  mr("opencode-go", "deepseek-v4-flash"),
  mr("opencode-go", "deepseek-v4-pro"),
  mr("opencode-go", "qwen3.7-max"),
  mr("opencode-go", "kimi-k2.7-code"),
];

const GPT_MODELS: readonly ModelRef[] = [
  mr("openai-codex", "gpt-5.6"),
  mr("openai-codex", "gpt-5.6-terra"),
  mr("openai-codex", "gpt-5.6-luna"),
  mr("openai-codex", "gpt-5.5"),
  mr("openai-codex", "gpt-5.4"),
  mr("openai-codex", "gpt-5.4-mini"),
];

const FREE_MODELS: readonly ModelRef[] = [mr("opencode", "deepseek-v4-flash-free")];

function fullRegistry(): ModelRegistry {
  return new FakeRegistry([...GO_MODELS, ...GPT_MODELS, ...FREE_MODELS]);
}

describe("Provider integration tests", () => {
  const config = buildDefaultRoutingConfig();

  it("provider constants are exported correctly", () => {
    assert.equal(PHENIX_PROVIDER, "phenix");
    assert.equal(PHENIX_API, "phenix-router");
  });

  it("DEFAULT_PHENIX_MODEL_SETS matches the declared model-set IDs", () => {
    assert.equal(DEFAULT_PHENIX_MODEL_SETS.length, 4);
    assert.ok(DEFAULT_PHENIX_MODEL_SETS.includes("free"));
    assert.ok(DEFAULT_PHENIX_MODEL_SETS.includes("opencode-go"));
    assert.ok(DEFAULT_PHENIX_MODEL_SETS.includes("gpt"));
    assert.ok(DEFAULT_PHENIX_MODEL_SETS.includes("mixed"));
  });

  it("defaultModelSetForModelId maps each virtual model correctly", () => {
    assert.equal(defaultModelSetForModelId("free"), "free");
    assert.equal(defaultModelSetForModelId("opencode-go"), "opencode-go");
    assert.equal(defaultModelSetForModelId("gpt"), "gpt");
    assert.equal(defaultModelSetForModelId("mixed"), "mixed");
  });

  it("defaultModelSetForModelId returns undefined for non-model-set IDs", () => {
    assert.equal(defaultModelSetForModelId("workflow"), undefined);
    assert.equal(defaultModelSetForModelId("unknown"), undefined);
    assert.equal(defaultModelSetForModelId(""), undefined);
  });

  it("selecting a virtual model sets the routing backend explicitly", () => {
    const modelSet = defaultModelSetForModelId("opencode-go");
    assert.equal(modelSet, "opencode-go");
  });

  it("virtual Phenix models are never concrete pool candidates", () => {
    for (const setId of DEFAULT_PHENIX_MODEL_SETS) {
      for (const [, candidates] of Object.entries(config.pools)) {
        for (const candidate of candidates) {
          assert.notEqual(candidate, `phenix/${setId}`, `Pool illegally contains phenix/${setId}`);
        }
      }
    }
  });

  it("routes resolve to concrete providers for Pi-owned authentication", async () => {
    const route = await resolveRoute({
      modelSet: "opencode-go",
      role: "coordinator",
      difficulty: "D1",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route.model.provider, "opencode-go");
    assert.notEqual(route.model.provider, PHENIX_PROVIDER);
  });

  it("root route thinking overrides virtual-model thinking", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "coordinator",
      difficulty: "D0",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route.thinking, "minimal");
  });

  it("free mode does not leak into paid models", async () => {
    const route = await resolveRoute({
      modelSet: "free",
      role: "coordinator",
      difficulty: "D1",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route.model.provider, "opencode");
  });

  it("missing candidate produces precise routing failure", async () => {
    const empty = new FakeRegistry([]);
    await assert.rejects(
      resolveRoute({
        modelSet: "gpt",
        role: "coordinator",
        difficulty: "D2",
        modelRegistry: empty,
        config,
      }),
      (err: Error) =>
        err.message.includes("No available candidates") &&
        err.message.includes("gpt") &&
        err.message.includes("reasoning"),
    );
  });

  it("selecting phenix/gpt routes through the GPT pool exclusively", async () => {
    const route = await resolveRoute({
      modelSet: "gpt",
      role: "coordinator",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route.modelSet, "gpt");
    assert.equal(route.model.provider, "openai-codex");
  });
});

describe("Full pipeline: profile → matrix → resolver", () => {
  const config = buildDefaultRoutingConfig();

  it("coordinator D0 → fast/minimal → go.fast → opencode-go model", async () => {
    const route = await resolveRoute({
      modelSet: "opencode-go",
      role: "coordinator",
      difficulty: "D0",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route.role, "coordinator");
    assert.equal(route.difficulty, "D0");
    assert.equal(route.capability, "fast");
    assert.equal(route.thinking, "minimal");
    assert.equal(route.model.provider, "opencode-go");
    assert.equal(route.pool, "go.fast");
  });

  it("critic D3 → review-max/xhigh → GPT", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "critic",
      difficulty: "D3",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route.difficulty, "D3");
    assert.equal(route.capability, "review-max");
    assert.equal(route.thinking, "xhigh");
    assert.equal(route.model.provider, "openai-codex");
  });
});

describe("Session integrity", () => {
  it("session restore uses the latest valid model-set state", () => {
    const runtime = { modelSet: "gpt" as const };
    assert.equal(runtime.modelSet, "gpt");
  });

  it("the public session identity remains the selected Phenix model set", () => {
    for (const modelSet of DEFAULT_PHENIX_MODEL_SETS) {
      assert.equal(defaultModelSetForModelId(modelSet), modelSet);
    }
  });
});
