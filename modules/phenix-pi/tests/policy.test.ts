import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  childAllowed,
  deriveTaskProfile,
  resolveExecutionPolicy,
  toolAllowed,
  type RuntimePolicyConfig,
} from "../extensions/phenix-subagents/policy.ts";

const config: RuntimePolicyConfig = {
  verification: {
    maxRepairAttempts: 1,
    timeoutMs: 120_000,
  },
};

describe("Phenix runtime policy", () => {
  it("raises consequence for security-sensitive work", () => {
    const profile = deriveTaskProfile(
      "implementer",
      "Change authentication permissions and credential handling",
      [],
    );
    assert.ok(profile.consequence >= 3);
  });

  it("selects role-aware thinking at runtime", () => {
    const policy = resolveExecutionPolicy({
      role: "critic",
      task: "Review a security-sensitive public API migration",
      requirements: ["Find all blockers"],
      cwd: process.cwd(),
      config,
    });
    assert.equal(policy.thinking, "high");
    assert.equal(policy.expectedAcceptance, "not-required");
  });

  it("keeps verification and review runtime-owned", () => {
    const policy = resolveExecutionPolicy({
      role: "implementer",
      task: "Implement a bounded TypeScript change",
      requirements: ["Behavior is correct", "Tests pass"],
      cwd: process.cwd(),
      config,
    });
    assert.equal(policy.expectedAcceptance, "not-required");
    assert.equal(policy.acceptance.level, "none");
    assert.equal(policy.verificationCommands[0]?.id, "phenix-runtime-verification");
    assert.equal(policy.criticRequired, true);
    assert.equal("verify" in policy.acceptance, false);
    assert.equal("review" in policy.acceptance, false);
  });

  it("enforces the fixed child-role graph and raw subagent ban", () => {
    assert.equal(childAllowed("planner", "architect"), true);
    assert.equal(childAllowed("tester", "implementer"), false);
    assert.equal(toolAllowed("implementer", "edit"), true);
    assert.equal(toolAllowed("implementer", "subagent"), false);
    assert.equal(toolAllowed("critic", "write"), false);
  });

  it("includes routing metadata fields in policy", () => {
    const policy = resolveExecutionPolicy({
      role: "scout",
      task: "Explore the codebase for issue #123",
      requirements: ["Find the relevant files"],
      cwd: process.cwd(),
      config,
    });
    // modelSet, difficulty, capability, candidatePool, candidateIndex
    // are optional fields that the routing extension fills in
    assert.equal(policy.role, "scout");
    assert.equal(policy.tier, "low");
    assert.equal(policy.thinking, "low");
    assert.ok(typeof policy.timeoutMs === "number");
  });
});
