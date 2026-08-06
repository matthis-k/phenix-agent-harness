import assert from "node:assert/strict";
import test from "node:test";

import { PhenixModelResolver } from "../adapters/routing/phenix-model-resolver.ts";
import type { ModelTarget } from "../domain/definition/model.ts";
import type { ModelInventory } from "../ports/model-resolver.ts";

class Inventory implements ModelInventory {
  private readonly models: readonly ModelTarget[];

  constructor(models: readonly ModelTarget[]) {
    this.models = models;
  }

  available(): readonly ModelTarget[] {
    return this.models;
  }

  contains(target: ModelTarget): boolean {
    return this.models.some(
      (candidate) =>
        candidate.backend === target.backend &&
        candidate.provider === target.provider &&
        candidate.model === target.model,
    );
  }
}

const all: readonly ModelTarget[] = [
  { backend: "pi", provider: "opencode", model: "deepseek-v4-flash-free" },
  { backend: "pi", provider: "opencode", model: "mimo-v2.5-free" },
  { backend: "pi", provider: "opencode-go", model: "mimo-v2.5" },
  { backend: "pi", provider: "opencode-go", model: "qwen3.7-plus" },
  { backend: "pi", provider: "opencode-go", model: "glm-5.2" },
  { backend: "pi", provider: "opencode-go", model: "kimi-k2.7-code" },
  { backend: "pi", provider: "openai-codex", model: "gpt-5.6-terra" },
  { backend: "pi", provider: "openai-codex", model: "gpt-5.6" },
];

async function resolve(
  modelSet: "free" | "opencode-go" | "chatgpt-plus" | "mixed",
  definitionId: string,
  difficulty: "D0" | "D1" | "D2" | "D3",
  budget?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
) {
  return new PhenixModelResolver(new Inventory(all)).resolve(
    { kind: "virtual", provider: "phenix", model: modelSet },
    {
      definitionId,
      parentDefinitionId: "root.session",
      thinking: "route",
      modelSet,
      difficulty,
      ...(budget ? { budget } : {}),
    },
  );
}

test("free routes every capability only to authenticated free candidates", async () => {
  const result = await resolve("free", "agent.implementer", "D3");
  assert.deepEqual(result.target, {
    backend: "pi",
    provider: "opencode",
    model: "deepseek-v4-flash-free",
  });
  assert.deepEqual(result.concrete, {
    kind: "concrete",
    provider: "opencode",
    model: "deepseek-v4-flash-free",
  });
  assert.equal(result.capability, "code-max");
});

test("session budget caps routed reasoning without changing capability selection", async () => {
  const low = await resolve("free", "agent.implementer", "D3", "low");
  const high = await resolve("free", "agent.implementer", "D3", "high");
  assert.equal(low.capability, "code-max");
  assert.equal(high.capability, "code-max");
  assert.equal(low.thinking, "low");
  assert.equal(high.thinking, "high");
});

test("OpenCode Go, ChatGPT Plus, and mixed select the capability-specific target", async () => {
  const go = await resolve("opencode-go", "agent.planner", "D3");
  assert.equal(
    `${go.target.backend}/${go.target.provider}/${go.target.model}`,
    "pi/opencode-go/glm-5.2",
  );

  const plus = await resolve("chatgpt-plus", "agent.verifier", "D2");
  assert.equal(
    `${plus.target.backend}/${plus.target.provider}/${plus.target.model}`,
    "pi/openai-codex/gpt-5.6-terra",
  );

  const mixedCode = await resolve("mixed", "agent.implementer", "D2");
  assert.equal(
    `${mixedCode.target.backend}/${mixedCode.target.provider}/${mixedCode.target.model}`,
    "pi/opencode-go/kimi-k2.7-code",
  );

  const mixedReasoning = await resolve("mixed", "agent.planner", "D2");
  assert.equal(
    `${mixedReasoning.target.backend}/${mixedReasoning.target.provider}/${mixedReasoning.target.model}`,
    "pi/openai-codex/gpt-5.6-terra",
  );
});

test("routing preserves ordered fallback candidates", async () => {
  const inventory = new Inventory([
    { backend: "pi", provider: "opencode", model: "mimo-v2.5-free" },
  ]);
  const candidates = await new PhenixModelResolver(inventory).resolveCandidates(
    { kind: "virtual", provider: "phenix", model: "free" },
    {
      definitionId: "agent.base",
      parentDefinitionId: "root.session",
      thinking: "route",
      modelSet: "free",
      difficulty: "D1",
    },
  );
  assert.deepEqual(
    candidates.map((item) => item.target),
    [{ backend: "pi", provider: "opencode", model: "mimo-v2.5-free" }],
  );
});

test("session selectors resolve through the owning session model set", async () => {
  const result = await new PhenixModelResolver(new Inventory(all)).resolve(
    { kind: "session" },
    {
      definitionId: "agent.implementer",
      parentDefinitionId: "root.session",
      thinking: "route",
      modelSet: "chatgpt-plus",
      difficulty: "D2",
    },
  );
  assert.equal(result.virtual?.model, "chatgpt-plus");
  assert.equal(result.target.backend, "pi");
  assert.equal(result.concrete.provider, "openai-codex");
});

test("unqualified concrete models cannot silently cross backend boundaries", async () => {
  const inventory = new Inventory([
    { backend: "pi", provider: "anthropic", model: "sonnet" },
    { backend: "claude", provider: "anthropic", model: "sonnet" },
  ]);
  const resolver = new PhenixModelResolver(inventory);
  const context = {
    definitionId: "agent.base",
    parentDefinitionId: "root.session",
    thinking: "route" as const,
    difficulty: "D1" as const,
  };

  await assert.rejects(
    resolver.resolve(
      { kind: "concrete", provider: "anthropic", model: "sonnet" },
      context,
    ),
    /exists in multiple backends/,
  );

  const resolved = await resolver.resolve(
    {
      kind: "target",
      backend: "claude",
      provider: "anthropic",
      model: "sonnet",
    },
    context,
  );
  assert.equal(resolved.target.backend, "claude");
  assert.deepEqual(resolved.concrete, {
    kind: "concrete",
    provider: "anthropic",
    model: "sonnet",
  });
});
