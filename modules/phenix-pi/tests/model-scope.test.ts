import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createProviderRootModelScope,
  phenixRootModelScope,
} from "../extensions/phenix-composition/model-scope.ts";

describe("root model scope", () => {
  it("matches only the configured directly selected provider", () => {
    assert.equal(phenixRootModelScope.includes({ provider: "phenix" }), true);
    assert.equal(phenixRootModelScope.includes({ provider: "openai-codex" }), false);
    assert.equal(phenixRootModelScope.includes(undefined), false);
  });

  it("contributes prompts without changing out-of-scope sessions", () => {
    assert.equal(
      phenixRootModelScope.contributeSystemPrompt({
        model: { provider: "openai-codex" },
        systemPrompt: "base",
        contribution: "Phenix only",
      }),
      undefined,
    );
    assert.equal(
      phenixRootModelScope.contributeSystemPrompt({
        model: { provider: "phenix" },
        systemPrompt: "base",
        contribution: "Phenix only",
      }),
      "base\n\nPhenix only",
    );
  });

  it("provides a reusable provider-scoped authorization boundary", () => {
    const scope = createProviderRootModelScope({ provider: "example", label: "Example" });

    assert.equal(
      scope.denialReason({
        model: { provider: "example" },
        capability: "example_tool",
      }),
      undefined,
    );
    assert.equal(
      scope.denialReason({
        model: { provider: "other" },
        capability: "example_tool",
      }),
      "example_tool is available only in Example root-model sessions.",
    );
  });
});
