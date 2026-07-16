import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bootstrapPhenixSubagentsSkillPrompt,
  buildPhenixRootSystemPrompt,
  shouldBootstrapPhenixSubagentsSkill,
} from "../extensions/phenix-skill-bootstrap.ts";

describe("Phenix root prompt bootstrap", () => {
  it("is enabled only for phenix provider models", () => {
    assert.equal(shouldBootstrapPhenixSubagentsSkill({ provider: "phenix" }), true);
    assert.equal(shouldBootstrapPhenixSubagentsSkill({ provider: "openai-codex" }), false);
    assert.equal(shouldBootstrapPhenixSubagentsSkill({ provider: "opencode-go" }), false);
    assert.equal(shouldBootstrapPhenixSubagentsSkill(null), false);
    assert.equal(shouldBootstrapPhenixSubagentsSkill(undefined), false);
  });

  it("injects the phenix-subagents skill content once", () => {
    const bootstrapped = bootstrapPhenixSubagentsSkillPrompt("base prompt");

    assert.match(bootstrapped, /Phenix workflow nodes, legal transitions/);
    assert.match(bootstrapped, /mandatory initial\s+authority inspection/i);
    assert.match(bootstrapped, /one advertised target `agent`/);
    assert.match(bootstrapped, /unique\s+legal transition/i);
    assert.match(bootstrapped, /action: "spawn"/);
    assert.match(bootstrapped, /substantial intermediate context/i);
    assert.match(bootstrapped, /not needed for your remaining work/i);
    assert.match(bootstrapped, /read the files required for your own task/i);
    assert.match(bootstrapped, /work you would need to repeat/i);
    assert.doesNotMatch(bootstrapped, /edgeId/);
    assert.doesNotMatch(bootstrapped, /phenix_create_subagent/);

    const again = bootstrapPhenixSubagentsSkillPrompt(bootstrapped);
    assert.equal(again, bootstrapped);
  });

  it("contributes the complete substrate only to Phenix root models", () => {
    const phenix = buildPhenixRootSystemPrompt({
      model: { provider: "phenix" },
      systemPrompt: "base prompt",
    });
    const external = buildPhenixRootSystemPrompt({
      model: { provider: "openai-codex" },
      systemPrompt: "base prompt",
    });

    assert.match(phenix ?? "", /## Phenix coding substrate/);
    assert.match(phenix ?? "", /target agents available from the current node/i);
    assert.match(phenix ?? "", /phenix_workflow/);
    assert.match(phenix ?? "", /broad repository reconnaissance/i);
    assert.match(phenix ?? "", /mechanical execution of an already-settled plan/i);
    assert.match(phenix ?? "", /decision-critical source inspection/i);
    assert.equal(external, undefined);
  });
});
