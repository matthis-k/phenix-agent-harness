import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { transitionAuthorityForChild } from "@matthis-k/phenix-flow/workflow-runtime.ts";
import { PHENIX_QA_WORKFLOW } from "@matthis-k/phenix-suite/defaults/workflow-presets.ts";

describe("child workflow lifecycle authority", () => {
  it("authorizes every QA transition the base actor may reach", () => {
    const authority = transitionAuthorityForChild({
      definition: PHENIX_QA_WORKFLOW,
      role: null,
      initialState: "executing",
      authorizedRoles: ["scout", "tester", "architect", "critic"],
    });

    assert.equal(authority.kind, "restricted");
    if (authority.kind !== "restricted") return;

    assert.deepEqual(authority.allowed, [
      "qa.scout",
      "qa.test",
      "qa.architecture",
      "qa.critic",
    ]);
  });

  it("still applies the child role ceiling", () => {
    const authority = transitionAuthorityForChild({
      definition: PHENIX_QA_WORKFLOW,
      role: null,
      initialState: "executing",
      authorizedRoles: ["scout", "tester"],
    });

    assert.equal(authority.kind, "restricted");
    if (authority.kind !== "restricted") return;
    assert.deepEqual(authority.allowed, ["qa.scout", "qa.test"]);
  });
});
