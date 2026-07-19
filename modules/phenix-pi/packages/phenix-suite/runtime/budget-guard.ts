/**
 * budget-guard — enforce turn/tool/timeout budgets through normalized events
 *
 * Observes turn_end, tool_execution_start, tool_execution_end, and elapsed
 * wall-clock time. Emits deterministic warnings and aborts on hard limits.
 *
 * Budget failures are distinguishable from provider, model, contract,
 * verification, and critic failures through structured runtime error codes.
 */

import type { ToolBudget, TurnBudget } from "../subagents/agent-types.ts";
import type { ChildRuntimeErrorCode, ChildSessionEvent } from "./child-session-types.ts";
import { ChildRuntimeError } from "./child-session-types.ts";

// ── Budget guard state ──────────────────────────────────────────────────────

export interface BudgetGuardConfig {
  readonly turnBudget: TurnBudget;
  readonly toolBudget: ToolBudget;
  readonly timeoutMs: number;
}

export interface BudgetViolation {
  readonly code: ChildRuntimeErrorCode;
  readonly message: string;
}

/**
 * Observe a single normalized event and return a violation if a budget
 * was exceeded. Returns undefined if no budget was violated.
 *
 * The guard is stateless per-call but receives mutable counters by
 * reference so it can track turns and tools across a cycle.
 */
export class BudgetGuard {
  private readonly config: BudgetGuardConfig;

  private turns = 0;
  private toolCalls = 0;
  private readonly startTime = Date.now();
  private softToolWarned = false;

  constructor(config: BudgetGuardConfig) {
    this.config = config;
  }

  /**
   * Observe a normalized event.
   *
   * Returns a BudgetViolation if a hard limit was exceeded.
   * Returns a soft warning string if the soft tool limit was reached.
   * Returns undefined otherwise.
   */
  observe(event: ChildSessionEvent): {
    readonly violation?: BudgetViolation;
    readonly softWarning?: string;
  } {
    // Check timeout on every event
    if (this.config.timeoutMs > 0) {
      const elapsed = Date.now() - this.startTime;
      if (elapsed >= this.config.timeoutMs) {
        return {
          violation: {
            code: "TIMEOUT",
            message: `Child session timed out after ${this.config.timeoutMs}ms.`,
          },
        };
      }
    }

    if (event.type === "tool.started") {
      this.toolCalls++;

      // Soft tool limit — emit one deterministic warning
      if (
        !this.softToolWarned &&
        this.config.toolBudget.soft > 0 &&
        this.toolCalls >= this.config.toolBudget.soft
      ) {
        this.softToolWarned = true;
        return {
          softWarning:
            `Tool call count (${this.toolCalls}) has reached the soft limit ` +
            `(${this.config.toolBudget.soft}). Be mindful of remaining tool budget ` +
            `(${this.config.toolBudget.hard - this.toolCalls} calls remaining to hard limit).`,
        };
      }

      // Hard tool limit — abort
      if (this.config.toolBudget.hard > 0 && this.toolCalls > this.config.toolBudget.hard) {
        return {
          violation: {
            code: "TOOL_BUDGET_EXCEEDED",
            message:
              `Tool budget exceeded: ${this.toolCalls} calls, hard limit is ` +
              `${this.config.toolBudget.hard}.`,
          },
        };
      }
    }

    if (event.type === "agent.event") {
      const raw = event.event as { type?: string };

      // Count turns on turn_end
      if (raw?.type === "turn_end") {
        this.turns++;

        // Turn limit — abort (accounting for grace turns)
        if (
          this.config.turnBudget.maxTurns > 0 &&
          this.turns > this.config.turnBudget.maxTurns + this.config.turnBudget.graceTurns
        ) {
          return {
            violation: {
              code: "TURN_BUDGET_EXCEEDED",
              message:
                `Turn budget exceeded: ${this.turns} turns, limit is ` +
                `${this.config.turnBudget.maxTurns} + ${this.config.turnBudget.graceTurns} grace.`,
            },
          };
        }
      }
    }

    return {};
  }

  /**
   * Check timeout without an event (for periodic checks).
   */
  checkTimeout(): BudgetViolation | undefined {
    if (this.config.timeoutMs > 0) {
      const elapsed = Date.now() - this.startTime;
      if (elapsed >= this.config.timeoutMs) {
        return {
          code: "TIMEOUT",
          message: `Child session timed out after ${this.config.timeoutMs}ms.`,
        };
      }
    }
    return undefined;
  }

  getTurns(): number {
    return this.turns;
  }

  getToolCalls(): number {
    return this.toolCalls;
  }

  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }
}

// ── Budget violation → ChildRuntimeError ────────────────────────────────────

export function budgetViolationToError(violation: BudgetViolation): ChildRuntimeError {
  return new ChildRuntimeError(violation.code, violation.message);
}
