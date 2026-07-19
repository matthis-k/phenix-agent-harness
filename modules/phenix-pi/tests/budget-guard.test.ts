/**
 * budget-guard.test.ts
 *
 * Verify:
 * - soft tool limit emits one warning
 * - hard tool limit aborts with TOOL_BUDGET_EXCEEDED
 * - turn limit aborts with TURN_BUDGET_EXCEEDED
 * - timeout aborts with TIMEOUT
 * - budget violations are distinguishable from each other
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BudgetGuard } from "@matthis-k/phenix-suite/runtime/budget-guard.ts";
import type {
  ChildRunId,
  ChildSessionEvent,
} from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import { childRunId } from "@matthis-k/phenix-suite/runtime/child-session-types.ts";

const runId: ChildRunId = childRunId("test-run");

function toolStartedEvent(name: string): ChildSessionEvent {
  return { type: "tool.started", runId, toolName: name };
}

function turnEndEvent(): ChildSessionEvent {
  return { type: "agent.event", runId, event: { type: "turn_end" } };
}

describe("BudgetGuard", () => {
  it("soft tool limit emits one warning", () => {
    const guard = new BudgetGuard({
      turnBudget: { maxTurns: 100, graceTurns: 0 },
      toolBudget: { soft: 3, hard: 10, block: [] },
      timeoutMs: 0,
    });

    // First 2 tools — no warning
    assert.equal(guard.observe(toolStartedEvent("t1")).softWarning, undefined);
    assert.equal(guard.observe(toolStartedEvent("t2")).softWarning, undefined);

    // Third tool — soft warning
    const result = guard.observe(toolStartedEvent("t3"));
    assert.ok(result.softWarning);
    assert.match(result.softWarning, /soft limit/);

    // Fourth tool — no more soft warnings (already warned)
    assert.equal(guard.observe(toolStartedEvent("t4")).softWarning, undefined);
  });

  it("hard tool limit aborts with TOOL_BUDGET_EXCEEDED", () => {
    const guard = new BudgetGuard({
      turnBudget: { maxTurns: 100, graceTurns: 0 },
      toolBudget: { soft: 2, hard: 3, block: [] },
      timeoutMs: 0,
    });

    guard.observe(toolStartedEvent("t1"));
    guard.observe(toolStartedEvent("t2"));
    guard.observe(toolStartedEvent("t3"));
    const result = guard.observe(toolStartedEvent("t4"));
    assert.ok(result.violation);
    assert.equal(result.violation.code, "TOOL_BUDGET_EXCEEDED");
  });

  it("turn limit aborts with TURN_BUDGET_EXCEEDED", () => {
    const guard = new BudgetGuard({
      turnBudget: { maxTurns: 2, graceTurns: 1 },
      toolBudget: { soft: 100, hard: 100, block: [] },
      timeoutMs: 0,
    });

    // 3 turns is OK (2 + 1 grace)
    guard.observe(turnEndEvent());
    guard.observe(turnEndEvent());
    guard.observe(turnEndEvent());

    // 4th turn exceeds
    const result = guard.observe(turnEndEvent());
    assert.ok(result.violation);
    assert.equal(result.violation.code, "TURN_BUDGET_EXCEEDED");
  });

  it("timeout aborts with TIMEOUT", () => {
    const guard = new BudgetGuard({
      turnBudget: { maxTurns: 100, graceTurns: 0 },
      toolBudget: { soft: 100, hard: 100, block: [] },
      timeoutMs: 1, // 1ms — will expire immediately
    });

    // Wait a moment for timeout to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = guard.observe(toolStartedEvent("t1"));
        assert.ok(result.violation);
        assert.equal(result.violation.code, "TIMEOUT");
        resolve();
      }, 10);
    });
  });

  it("budget violations are distinguishable", () => {
    const toolGuard = new BudgetGuard({
      turnBudget: { maxTurns: 100, graceTurns: 0 },
      toolBudget: { soft: 1, hard: 1, block: [] },
      timeoutMs: 0,
    });

    toolGuard.observe(toolStartedEvent("t1"));
    const toolViolation = toolGuard.observe(toolStartedEvent("t2")).violation;
    assert.equal(toolViolation?.code, "TOOL_BUDGET_EXCEEDED");

    const turnGuard = new BudgetGuard({
      turnBudget: { maxTurns: 1, graceTurns: 0 },
      toolBudget: { soft: 100, hard: 100, block: [] },
      timeoutMs: 0,
    });

    turnGuard.observe(turnEndEvent());
    const turnViolation = turnGuard.observe(turnEndEvent()).violation;
    assert.equal(turnViolation?.code, "TURN_BUDGET_EXCEEDED");

    assert.notEqual(toolViolation?.code, turnViolation?.code);
  });

  it("checkTimeout returns violation after timeout", () => {
    const guard = new BudgetGuard({
      turnBudget: { maxTurns: 100, graceTurns: 0 },
      toolBudget: { soft: 100, hard: 100, block: [] },
      timeoutMs: 1,
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const violation = guard.checkTimeout();
        assert.ok(violation);
        assert.equal(violation.code, "TIMEOUT");
        resolve();
      }, 10);
    });
  });
});
