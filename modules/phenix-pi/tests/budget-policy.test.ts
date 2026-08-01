import assert from "node:assert/strict";
import test from "node:test";

import { phenixBudgetPolicy } from "../suite/phenix-budget-policy.ts";

const BASE = {
  timeoutMs: 900_000,
  maxTurns: 18,
  maxRepairAttempts: 2,
} as const;

test("budget tiers scale agent resources around the definition baseline", () => {
  assert.deepEqual(phenixBudgetPolicy.applyAgentLimits(BASE, "medium"), BASE);
  assert.deepEqual(phenixBudgetPolicy.applyAgentLimits(BASE, "low"), {
    timeoutMs: 675_000,
    maxTurns: 14,
    maxToolCalls: 84,
    maxRepairAttempts: 1,
  });
  assert.deepEqual(phenixBudgetPolicy.applyAgentLimits(BASE, "high"), {
    timeoutMs: 1_800_000,
    maxTurns: 36,
    maxRepairAttempts: 3,
  });
});

test("max removes agent resource ceilings but keeps repair loops bounded", () => {
  assert.deepEqual(phenixBudgetPolicy.applyAgentLimits(BASE, "max"), {
    maxRepairAttempts: 5,
  });
});

test("budget caps reasoning independently from routed capability", () => {
  assert.equal(phenixBudgetPolicy.capThinking("xhigh", "low"), "low");
  assert.equal(phenixBudgetPolicy.capThinking("xhigh", "medium"), "xhigh");
  assert.equal(phenixBudgetPolicy.capThinking("max", "high"), "xhigh");
  assert.equal(phenixBudgetPolicy.capThinking("high", "max"), "high");
});
