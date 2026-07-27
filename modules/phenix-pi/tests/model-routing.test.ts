import assert from "node:assert/strict";
import test from "node:test";

import { PhenixModelResolver } from "../adapters/routing/phenix-model-resolver.ts";
import type { ModelInventory } from "../ports/model-resolver.ts";

class Inventory implements ModelInventory {
  private readonly models: readonly { provider: string; model: string }[];

  constructor(models: readonly { provider: string; model: string }[]) {
    this.models = models;
  }

  contains(provider: string, model: string): boolean {
    return this.models.some(
      (candidate) => candidate.provider === provider && candidate.model === model,
    );
  }
}

const all = [
  { provider: "opencode", model: "deepseek-v4-flash-free" },
  { provider: "opencode-go", model: "mimo-v2.5" },
  { provider: "opencode-go", model: "qwen3.7-plus" },
  { provider: "opencode-go", model: "glm-5.1" },
  { provider: "opencode-go", model: "glm-5.2" },
  { provider: "opencode-go", model: "kimi-k2.6" },
  { provider: "opencode-go", model: "kimi-k2.7-code" },
  { provider: "opencode-go", model: "qwen3.7-max" },
  { provider: "openai-codex", model: "gpt-5.6-luna" },
  { provider: "openai-codex", model: "gpt-5.6-terra" },
  { provider: "openai-codex", model: "gpt-5.6-sol" },
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

test("free routes every capability to its configured free model", async () => {
  const result = await resolve("free", "agent.implementer", "D3");
  assert.deepEqual(result.concrete, {
    kind: "concrete",
    provider: "opencode",
    model: "deepseek-v4-flash-free",
  });
  assert.equal(result.capability, "code-max");
});

test("model sets select exactly one capability-specific model", async () => {
  const go = await resolve("opencode-go", "agent.planner", "D3");
  assert.equal(`${go.concrete.provider}/${go.concrete.model}`, "opencode-go/glm-5.2");

  const plusFast = await resolve("chatgpt-plus", "agent.scout", "D0");
  assert.equal(
    `${plusFast.concrete.provider}/${plusFast.concrete.model}`,
    "openai-codex/gpt-5.6-luna",
  );

  const plus = await resolve("chatgpt-plus", "agent.verifier", "D2");
  assert.equal(`${plus.concrete.provider}/${plus.concrete.model}`, "openai-codex/gpt-5.6-terra");

  const plusMax = await resolve("chatgpt-plus", "agent.verifier", "D3");
  assert.equal(
    `${plusMax.concrete.provider}/${plusMax.concrete.model}`,
    "openai-codex/gpt-5.6-sol",
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

test("an unavailable configured model fails instead of falling back", async () => {
  const resolver = new PhenixModelResolver(
    new Inventory([{ provider: "openai-codex", model: "gpt-5.6-terra" }]),
  );

  await assert.rejects(
    resolver.resolve(
      { kind: "virtual", provider: "phenix", model: "chatgpt-plus" },
      {
        definitionId: "agent.verifier",
        parentDefinitionId: "root.session",
        thinking: "route",
        modelSet: "chatgpt-plus",
        difficulty: "D3",
      },
    ),
    /gpt-5\.6-sol.*is unavailable/,
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
