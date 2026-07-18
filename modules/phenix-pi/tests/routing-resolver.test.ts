import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBundledConfig } from "../extensions/phenix-routing/config.ts";
import { type ModelRegistry, resolveRoute } from "../extensions/phenix-routing/resolver.ts";
import type { ModelRef } from "../extensions/phenix-routing/types.ts";

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

const ALL_GO_AVAILABLE: readonly ModelRef[] = [
  mr("opencode-go", "deepseek-v4-flash"),
  mr("opencode-go", "mimo-v2.5"),
  mr("opencode-go", "deepseek-v4-pro"),
  mr("opencode-go", "qwen3.7-plus"),
  mr("opencode-go", "glm-5.1"),
  mr("opencode-go", "qwen3.7-max"),
  mr("opencode-go", "glm-5.2"),
  mr("opencode-go", "kimi-k2.6"),
  mr("opencode-go", "kimi-k2.7-code"),
];

const ALL_GPT_AVAILABLE: readonly ModelRef[] = [
  mr("openai-codex", "gpt-5.4-mini"),
  mr("openai-codex", "gpt-5.5"),
  mr("openai-codex", "gpt-5.4"),
  mr("openai-codex", "gpt-5.5"),
];

const FREE_AVAILABLE: readonly ModelRef[] = [mr("opencode", "deepseek-v4-flash-free")];

function goRegistry(): ModelRegistry {
  return new FakeRegistry([...ALL_GO_AVAILABLE, ...ALL_GPT_AVAILABLE, ...FREE_AVAILABLE]);
}

describe("Route resolution", () => {
  const config = buildBundledConfig();

  it("first available authenticated candidate wins", async () => {
    const route = await resolveRoute({
      modelSet: "opencode-go",
      role: "coordinator",
      difficulty: "D2",
      modelRegistry: goRegistry(),
      config,
    });
    assert.equal(route.modelSet, "opencode-go");
    assert.equal(route.capability, "reasoning");
    assert.equal(route.model.provider, "opencode-go");
    assert.equal(route.difficulty, "D2");
    assert.equal(route.candidateIndex, 0);
  });

  it("missing candidates are skipped, next available is used", async () => {
    const partial = new FakeRegistry([mr("opencode-go", "qwen3.7-max")]);
    const route = await resolveRoute({
      modelSet: "opencode-go",
      role: "critic",
      difficulty: "D1",
      modelRegistry: partial,
      config,
    });
    assert.equal(route.model.provider, "opencode-go");
    assert.equal(route.model.model, "qwen3.7-max");
  });

  it("unauthenticated candidates produce error", async () => {
    const registry = new FakeRegistry([]);
    await assert.rejects(
      resolveRoute({
        modelSet: "opencode-go",
        role: "coordinator",
        difficulty: "D0",
        modelRegistry: registry,
        config,
      }),
      (err: Error) => {
        return (
          err.message.includes("No available candidates") && err.message.includes("opencode-go")
        );
      },
    );
  });

  it("no route can resolve to phenix/workflow", async () => {
    const route = await resolveRoute({
      modelSet: "opencode-go",
      role: "implementer",
      difficulty: "D1",
      modelRegistry: goRegistry(),
      config,
    });
    assert.notEqual(route.model.provider, "phenix");
    assert.notEqual(`${route.model.provider}/${route.model.model}`, "phenix/workflow");
  });

  it("no cross-model-set fallback", async () => {
    const registry = new FakeRegistry(FREE_AVAILABLE);
    await assert.rejects(
      resolveRoute({
        modelSet: "gpt",
        role: "coordinator",
        difficulty: "D1",
        modelRegistry: registry,
        config,
      }),
      (err: Error) => {
        return err.message.includes("No available candidates") && err.message.includes("gpt");
      },
    );
  });

  it("avoidModels selects a different model in same pool", async () => {
    // critic D1 in opencode-go → "review" → "go.review" → [qwen3.7-max, deepseek-v4-pro]
    const route = await resolveRoute({
      modelSet: "opencode-go",
      role: "critic",
      difficulty: "D1",
      modelRegistry: goRegistry(),
      config,
      avoidModels: [mr("opencode-go", "deepseek-v4-pro")],
    });
    assert.equal(route.model.model, "qwen3.7-max");
    assert.equal(route.usedAvoidedModelFallback, false);
  });

  it("same-model critic fallback is explicitly recorded", async () => {
    // critic D0 in opencode-go → "general" → "go.general" → [deepseek-v4-pro, qwen3.7-plus]
    // Make only deepseek-v4-pro available and avoid it
    const registry = new FakeRegistry([mr("opencode-go", "deepseek-v4-pro")]);
    const route = await resolveRoute({
      modelSet: "opencode-go",
      role: "critic",
      difficulty: "D0",
      modelRegistry: registry,
      config,
      avoidModels: [mr("opencode-go", "deepseek-v4-pro")],
    });
    assert.equal(route.usedAvoidedModelFallback, true);
    assert.equal(route.model.model, "deepseek-v4-pro");
  });

  it("mixed mode routes implementer through go and critic through gpt where available", async () => {
    const reg = new FakeRegistry([
      mr("opencode-go", "kimi-k2.7-code"),
      mr("openai-codex", "gpt-5.4"),
    ]);

    const implRoute = await resolveRoute({
      modelSet: "mixed",
      role: "implementer",
      difficulty: "D1",
      modelRegistry: reg,
      config,
    });
    assert.equal(implRoute.model.provider, "opencode-go");

    const critRoute = await resolveRoute({
      modelSet: "mixed",
      role: "critic",
      difficulty: "D1",
      modelRegistry: reg,
      config,
      avoidModels: [implRoute.model],
    });
    // critic D1 / mixed → review → gpt.review → [gpt-5.5-thinking, gpt-5.5-pro]
    assert.equal(critRoute.model.provider, "openai-codex");
  });
});

describe("Workflow-owned route difficulty", () => {
  const config = buildBundledConfig();

  it("resolves the workflow-derived D0 route", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "coordinator",
      difficulty: "D0",
      modelRegistry: goRegistry(),
      config,
    });
    assert.equal(route.difficulty, "D0");
  });

  it("resolves the workflow-derived D3 route", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "coordinator",
      difficulty: "D3",
      modelRegistry: goRegistry(),
      config,
    });
    assert.equal(route.difficulty, "D3");
  });
});
