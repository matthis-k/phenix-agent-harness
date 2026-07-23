import assert from "node:assert/strict";
import test from "node:test";

import { PhenixModelResolver } from "../adapters/routing/phenix-model-resolver.ts";

test("virtual mixed model resolves once to a reproducible concrete model", async () => {
  const resolver = new PhenixModelResolver({
    available: () => [
      { provider: "openai-codex", model: "gpt-5.5" },
      { provider: "opencode-go", model: "qwen3.6-plus" },
    ],
    contains: () => true,
  });
  const result = await resolver.resolve(
    { kind: "virtual", provider: "phenix", model: "mixed" },
    { definitionId: "agent.implementer", parentDefinitionId: "root.session", thinking: "route" },
  );
  const repeated = await resolver.resolve(
    { kind: "virtual", provider: "phenix", model: "mixed" },
    { definitionId: "agent.implementer", parentDefinitionId: "root.session", thinking: "route" },
  );
  assert.deepEqual(result.concrete, repeated.concrete);
  assert.ok(["openai-codex", "opencode-go"].includes(result.concrete.provider));
  assert.equal(result.requested.model, "mixed");
  assert.equal(result.thinking, "medium");
  assert.equal(result.policyRevision, "phenix-mixed-v1");
});
