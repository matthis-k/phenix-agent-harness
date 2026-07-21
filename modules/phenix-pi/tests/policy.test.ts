import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveTaskProfile,
  type RuntimePolicyConfig,
  resolveExecutionPolicy,
} from "@matthis-k/phenix-suite/subagents/policy.ts";

const config: RuntimePolicyConfig = {
  verification: {
    maxRepairAttempts: 1,
    timeoutMs: 120_000,
  },
};

const QA_SPECIALISTS = ["scout", "tester", "architect", "critic"] as const;

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
    assert.equal(policy.criticRequired, false);
  });

  it("implementer gets runtime verification and critic", () => {
    const policy = resolveExecutionPolicy({
      role: "implementer",
      task: "Implement a bounded TypeScript change",
      requirements: ["Behavior is correct", "Tests pass"],
      cwd: process.cwd(),
      config,
    });
    assert.equal(policy.verificationCommands[0]?.id, "phenix-runtime-verification");
    assert.equal(policy.criticRequired, true);
  });

  it("base execution has a standard open-ended QA profile", () => {
    const policy = resolveExecutionPolicy({
      role: null,
      task: "Do something minimal",
      requirements: [],
      cwd: process.cwd(),
      config,
    });
    assert.equal(policy.agent, "phenix.base");
    assert.equal(policy.tier, "standard");
    assert.deepEqual(policy.turnBudget, {});
    assert.equal(policy.toolBudget.hard, undefined);
    assert.equal(policy.thinking, "medium");
    assert.equal(policy.criticRequired, false);
    assert.equal(policy.verificationCommands.length, 0);
    assert.deepEqual(policy.allowedChildren, QA_SPECIALISTS);
  });

  it("preserves an explicitly configured hard turn cap", () => {
    const policy = resolveExecutionPolicy({
      role: "scout",
      task: "Perform one bounded lookup",
      requirements: [],
      cwd: process.cwd(),
      config: {
        ...config,
        execution: { turnBudget: { maxTurns: 8, graceTurns: 1 } },
      },
    });
    assert.deepEqual(policy.turnBudget, { maxTurns: 8, graceTurns: 1 });
  });

  it("includes routing metadata fields in policy", () => {
    const policy = resolveExecutionPolicy({
      role: "scout",
      task: "Explore the codebase for issue #123",
      requirements: ["Find the relevant files"],
      cwd: process.cwd(),
      config,
    });
    assert.equal(policy.role, "scout");
    assert.equal(policy.tier, "low");
    assert.equal(policy.thinking, "low");
    assert.ok(typeof policy.timeoutMs === "number");
  });
});
