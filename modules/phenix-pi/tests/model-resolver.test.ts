import assert from "node:assert/strict";
import test from "node:test";

import { PhenixModelResolver } from "../adapters/routing/phenix-model-resolver.ts";

test("virtual mixed model resolves once to the first authenticated capability candidate", async () => {
  const resolver = new PhenixModelResolver({
    available: () => [
      { provider: "opencode-go", model: "kimi-k2.7-code" },
      { provider: "opencode-go", model: "deepseek-v4-pro" },
      { provider: "openai-codex", model: "gpt-5.6-terra" },
    ],
    contains: () => true,
  });
  const context = {
    definitionId: "agent.implementer",
    parentDefinitionId: "root.session",
    thinking: "route" as const,
    modelSet: "mixed" as const,
    difficulty: "D1" as const,
  };
  const result = await resolver.resolve(
    { kind: "virtual", provider: "phenix", model: "mixed" },
    context,
  );
  const repeated = await resolver.resolve(
    { kind: "virtual", provider: "phenix", model: "mixed" },
    context,
  );
  assert.deepEqual(result.concrete, repeated.concrete);
  assert.deepEqual(result.concrete, {
    kind: "concrete",
    provider: "opencode-go",
    model: "kimi-k2.7-code",
  });
  assert.equal(result.requested.kind, "virtual");
  if (result.requested.kind === "virtual") assert.equal(result.requested.model, "mixed");
  assert.equal(result.capability, "code");
  assert.equal(result.thinking, "low");
  assert.equal(result.policyRevision, "phenix-routing-v2");
});
