import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assurancePolicyFor } from "../packages/phenix-suite/authority/index.ts";

describe("assurancePolicyFor", () => {
  it("keeps trivial read-only questions direct", () => {
    const policy = assurancePolicyFor({
      userTask: "Explain how this interface works",
      difficulty: "D0",
      mutation: "none",
      uncertainty: "low",
    });
    assert.equal(policy.level, "A0");
    assert.equal(policy.semanticVerifierRequired, false);
  });

  it("requires verification for full QA independently of prompt difficulty", () => {
    const policy = assurancePolicyFor({
      userTask: "Do a full QA pass",
      difficulty: "D0",
      mutation: "none",
      deterministicChecksAvailable: true,
    });
    assert.equal(policy.level, "A2");
    assert.equal(policy.deterministicVerificationRequired, true);
  });

  it("raises security and deployment changes to high assurance", () => {
    const policy = assurancePolicyFor({
      userTask: "Update authentication deployment",
      difficulty: "D1",
      mutation: "broad",
      changeKinds: ["auth", "deployment"],
      deterministicChecksAvailable: true,
    });
    assert.equal(policy.level, "A3");
    assert.equal(policy.semanticVerifierRequired, true);
    assert.equal(policy.criticRequired, true);
    assert.equal(policy.isolationRequired, true);
  });
});
