import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bootstrapPhenixSubagentsSkillPrompt,
  shouldBootstrapPhenixSubagentsSkill,
} from "../extensions/phenix-skill-bootstrap.ts";

describe("Phenix subagents skill bootstrap", () => {
  it("is enabled only for phenix provider models", () => {
    assert.equal(shouldBootstrapPhenixSubagentsSkill({ provider: "phenix" }), true);
    assert.equal(shouldBootstrapPhenixSubagentsSkill({ provider: "openai-codex" }), false);
    assert.equal(shouldBootstrapPhenixSubagentsSkill({ provider: "opencode-go" }), false);
    assert.equal(shouldBootstrapPhenixSubagentsSkill(null), false);
    assert.equal(shouldBootstrapPhenixSubagentsSkill(undefined), false);
  });

  it("injects the phenix-subagents skill content once", () => {
    const bootstrapped = bootstrapPhenixSubagentsSkillPrompt("base prompt");

    assert.match(bootstrapped, /<skill name="phenix-subagents"/);
    assert.match(bootstrapped, /Phenix workflow states, legal transitions/);
    assert.match(bootstrapped, /Use only the delegation transitions projected into the current system prompt/);

    const again = bootstrapPhenixSubagentsSkillPrompt(bootstrapped);
    assert.equal(again, bootstrapped);
  });
});
