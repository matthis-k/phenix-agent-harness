import assert from "node:assert/strict";
import test from "node:test";

import { PhenixModelResolver } from "../adapters/routing/phenix-model-resolver.ts";
import type { ModelTarget } from "../domain/definition/model.ts";

function inventory(targets: readonly ModelTarget[]) {
  return {
    available: () => targets,
    contains: (target: ModelTarget) =>
      targets.some(
        (candidate) =>
          candidate.backend === target.backend &&
          candidate.provider === target.provider &&
          candidate.model === target.model,
      ),
  };
}

test("virtual mixed model resolves once to the first authenticated capability candidate", async () => {
  const resolver = new PhenixModelResolver(
    inventory([
      { backend: "pi", provider: "opencode-go", model: "kimi-k2.7-code" },
      { backend: "pi", provider: "opencode-go", model: "deepseek-v4-pro" },
      { backend: "pi", provider: "openai-codex", model: "gpt-5.6-terra" },
    ]),
  );
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
  assert.deepEqual(result.target, repeated.target);
  assert.deepEqual(result.target, {
    backend: "pi",
    provider: "opencode-go",
    model: "kimi-k2.7-code",
  });
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

test("a definition-declared capability overrides role fallback routing", async () => {
  const resolver = new PhenixModelResolver(
    inventory([
      { backend: "pi", provider: "openai-codex", model: "gpt-5.6" },
      { backend: "pi", provider: "openai-codex", model: "gpt-5.6-terra" },
    ]),
  );
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
  assert.deepEqual(result.target, {
    backend: "pi",
    provider: "openai-codex",
    model: "gpt-5.6",
  });
  assert.deepEqual(result.concrete, {
    kind: "concrete",
    provider: "openai-codex",
    model: "gpt-5.6",
  });
});
