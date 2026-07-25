import assert from "node:assert/strict";
import test from "node:test";

import {
  type BudgetSuspension,
  encodeBudgetResumeControl,
  parseBudgetResumeControl,
  resolveResumeLimits,
  resumedTimeoutRemaining,
} from "../application/budget-suspension.ts";
import type { RunId } from "../domain/shared.ts";

const suspension: BudgetSuspension = {
  runId: "run-budget" as RunId,
  failure: {
    code: "turn_budget_exceeded",
    message: "Agent exceeded 20 turns",
    retryable: true,
    details: {
      source: "automatic",
      category: "resource_limit",
      summary: "Agent exceeded 20 turns",
      retryable: true,
      suggestedLimits: { maxTurns: 44 },
    },
  },
  currentLimits: {
    timeoutMs: 120_000,
    maxTurns: 20,
    maxToolCalls: 40,
    maxRepairAttempts: 1,
  },
  suggestedLimits: { maxTurns: 44 },
  timeoutRemainingMs: 35_000,
  turnCount: 21,
  toolCallCount: 18,
  timestamp: "2026-07-25T00:00:00.000Z",
  sequence: 7,
};

test("budget resume controls round-trip explicit limits and parent guidance", () => {
  const encoded = encodeBudgetResumeControl({
    limits: { maxTurns: 50, maxToolCalls: null },
    message: "Continue from the existing analysis and finish the report.",
  });
  assert.deepEqual(parseBudgetResumeControl(encoded), {
    limits: { maxTurns: 50, maxToolCalls: null },
    message: "Continue from the existing analysis and finish the report.",
  });
  assert.equal(parseBudgetResumeControl("ordinary parent steering"), undefined);
});

test("accepting suggested limits preserves other budgets and the same cumulative run", () => {
  assert.deepEqual(resolveResumeLimits(suspension), {
    timeoutMs: 120_000,
    maxTurns: 44,
    maxToolCalls: 40,
    maxRepairAttempts: 1,
  });
  assert.equal(resumedTimeoutRemaining(suspension, resolveResumeLimits(suspension)), 35_000);
});

test("parent overrides may increase or remove limits but may not reduce them", () => {
  assert.deepEqual(
    resolveResumeLimits(suspension, {
      timeoutMs: 180_000,
      maxTurns: 60,
      maxToolCalls: null,
      maxRepairAttempts: 2,
    }),
    {
      timeoutMs: 180_000,
      maxTurns: 60,
      maxRepairAttempts: 2,
    },
  );
  assert.equal(
    resumedTimeoutRemaining(suspension, resolveResumeLimits(suspension, { timeoutMs: 180_000 })),
    95_000,
  );
  assert.throws(
    () => resolveResumeLimits(suspension, { maxTurns: 19 }),
    /maxTurns may not decrease/,
  );
  assert.throws(
    () => resolveResumeLimits(suspension, { maxTurns: 20 }),
    /at least one increased or removed budget limit/,
  );
});
