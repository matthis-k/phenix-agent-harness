import assert from "node:assert/strict";
import test from "node:test";

import { PhenixModelResolver } from "../adapters/routing/phenix-model-resolver.ts";

test("virtual mixed model resolves deterministically to its configured model", async () => {
  const resolver = new PhenixModelResolver({
    contains: (provider, model) => provider === "opencode-go" && model === "kimi-k2.7-code",
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
});

test("a definition-declared capability overrides role routing", async () => {
  const resolver = new PhenixModelResolver({
    contains: (provider, model) => provider === "openai-codex" && model === "gpt-5.6-sol",
  });
  const result = await resolver.resolve(
    { kind: "virtual", provider: "phenix", model: "mixed" },
    {
      definitionId: "agent.implementer",
      parentDefinitionId: "workflow.qa",
      thinking: "xhigh",
      modelSet: "mixed",
      difficulty: "D0",
      capability: "review-max",
    },
  );
  assert.equal(result.capability, "review-max");
  assert.equal(result.thinking, "xhigh");
  assert.deepEqual(result.concrete, {
    kind: "concrete",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  });
});
