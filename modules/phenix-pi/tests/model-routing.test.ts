import assert from "node:assert/strict";
import test from "node:test";

import { PhenixModelResolver } from "../adapters/routing/phenix-model-resolver.ts";
import type { ModelInventory } from "../ports/model-resolver.ts";

class Inventory implements ModelInventory {
  private readonly models: readonly { provider: string; model: string }[];

  constructor(models: readonly { provider: string; model: string }[]) {
    this.models = models;
  }

  available() {
    return this.models;
  }

  contains(provider: string, model: string): boolean {
    return this.models.some(
      (candidate) => candidate.provider === provider && candidate.model === model,
    );
  }
}

const all = [
  { provider: "opencode", model: "deepseek-v4-flash-free" },
  { provider: "opencode", model: "mimo-v2.5-free" },
  { provider: "opencode-go", model: "mimo-v2.5" },
  { provider: "opencode-go", model: "qwen3.7-plus" },
  { provider: "opencode-go", model: "glm-5.2" },
  { provider: "opencode-go", model: "kimi-k2.7-code" },
  { provider: "openai-codex", model: "gpt-5.6-terra" },
  { provider: "openai-codex", model: "gpt-5.6" },
];

async function resolve(
  modelSet: "free" | "opencode-go" | "chatgpt-plus" | "mixed",
  definitionId: string,
  difficulty: "D0" | "D1" | "D2" | "D3",
) {
  return new PhenixModelResolver(new Inventory(all)).resolve(
    { kind: "virtual", provider: "phenix", model: modelSet },
    {
      definitionId,
      parentDefinitionId: "root.session",
      thinking: "route",
      modelSet,
      difficulty,
    },
  );
}

test("free routes every capability only to authenticated free candidates", async () => {
  const result = await resolve("free", "agent.implementer", "D3");
  assert.deepEqual(result.concrete, {
    kind: "concrete",
    provider: "opencode",
    model: "deepseek-v4-flash-free",
  });
  assert.equal(result.capability, "code-max");
});

test("OpenCode Go, ChatGPT Plus, and mixed select the capability-specific provider", async () => {
  const go = await resolve("opencode-go", "agent.planner", "D3");
  assert.equal(`${go.concrete.provider}/${go.concrete.model}`, "opencode-go/glm-5.2");

  const plus = await resolve("chatgpt-plus", "agent.verifier", "D2");
  assert.equal(
    `${plus.concrete.provider}/${plus.concrete.model}`,
    "openai-codex/gpt-5.6-terra",
  );

  const mixedCode = await resolve("mixed", "agent.implementer", "D2");
  assert.equal(
    `${mixedCode.concrete.provider}/${mixedCode.concrete.model}`,
    "opencode-go/kimi-k2.7-code",
  );

  const mixedReasoning = await resolve("mixed", "agent.planner", "D2");
  assert.equal(
    `${mixedReasoning.concrete.provider}/${mixedReasoning.concrete.model}`,
    "openai-codex/gpt-5.6-terra",
  );
});

test("routing preserves ordered fallback candidates", async () => {
  const inventory = new Inventory([{ provider: "opencode", model: "mimo-v2.5-free" }]);
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
    candidates.map((item) => item.concrete.model),
    ["mimo-v2.5-free"],
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
  assert.equal(result.concrete.provider, "openai-codex");
});
