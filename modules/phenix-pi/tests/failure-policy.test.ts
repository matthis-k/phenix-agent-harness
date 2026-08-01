import assert from "node:assert/strict";
import test from "node:test";

import { defaultAgentFailureRetryable, type FailureCategory } from "../domain/shared.ts";

test("structural agent failures are not retried by default", () => {
  const structural: readonly FailureCategory[] = [
    "blocked",
    "deadlock",
    "insufficient_permissions",
    "invalid_task",
    "other",
  ];

  for (const category of structural) {
    assert.equal(defaultAgentFailureRetryable(category), false, category);
  }
});

test("only transient or actionable resource failures retry by default", () => {
  assert.equal(defaultAgentFailureRetryable("external_failure"), true);
  assert.equal(defaultAgentFailureRetryable("resource_limit"), false);
  assert.equal(defaultAgentFailureRetryable("resource_limit", {}), false);
  assert.equal(defaultAgentFailureRetryable("resource_limit", { maxTurns: null }), true);
  assert.equal(defaultAgentFailureRetryable("resource_limit", { timeoutMs: 120_000 }), true);
});
