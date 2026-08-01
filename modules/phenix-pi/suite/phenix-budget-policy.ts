import type { AgentLimits } from "../domain/definition/definition.ts";
import {
  effortIndex,
  type BudgetMode,
  type EffortLevel,
} from "../domain/definition/effort.ts";
import type { PiThinkingLevel } from "../domain/definition/model.ts";
import type { BudgetPolicy } from "../ports/budget-policy.ts";

interface FiniteBudget {
  readonly scale: number;
  readonly thinkingCeiling: PiThinkingLevel;
  readonly repairDelta: number;
}

const FINITE_BUDGETS: Readonly<Record<Exclude<BudgetMode, "max">, FiniteBudget>> = {
  off: { scale: 0.25, thinkingCeiling: "off", repairDelta: -10 },
  minimal: { scale: 0.5, thinkingCeiling: "minimal", repairDelta: -10 },
  low: { scale: 0.75, thinkingCeiling: "low", repairDelta: -1 },
  medium: { scale: 1, thinkingCeiling: "xhigh", repairDelta: 0 },
  high: { scale: 2, thinkingCeiling: "xhigh", repairDelta: 1 },
  xhigh: { scale: 4, thinkingCeiling: "max", repairDelta: 2 },
};

export const phenixBudgetPolicy: BudgetPolicy = Object.freeze({
  applyAgentLimits(base: AgentLimits, budget: BudgetMode) {
    if (budget === "max") {
      return { maxRepairAttempts: Math.min(10, Math.max(5, base.maxRepairAttempts)) };
    }

    const policy = FINITE_BUDGETS[budget];
    const timeoutMs =
      base.timeoutMs === undefined
        ? undefined
        : Math.min(3_600_000, Math.max(30_000, scaled(base.timeoutMs, policy.scale)));
    const maxTurns = scaledOptional(base.maxTurns, policy.scale);
    const maxToolCalls =
      base.maxToolCalls !== undefined
        ? scaled(base.maxToolCalls, policy.scale)
        : effortIndex(budget) <= effortIndex("low") && maxTurns !== undefined
          ? maxTurns * 6
          : undefined;
    const maxRepairAttempts = Math.min(
      10,
      Math.max(0, base.maxRepairAttempts + policy.repairDelta),
    );

    return {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
      maxRepairAttempts,
    };
  },

  capThinking(requested: PiThinkingLevel, budget: BudgetMode) {
    if (budget === "max") return requested;
    const ceiling = FINITE_BUDGETS[budget].thinkingCeiling;
    return effortIndex(requested as EffortLevel) <= effortIndex(ceiling as EffortLevel)
      ? requested
      : ceiling;
  },
});

function scaled(value: number, factor: number): number {
  return Math.max(1, Math.ceil(value * factor));
}

function scaledOptional(value: number | undefined, factor: number): number | undefined {
  return value === undefined ? undefined : scaled(value, factor);
}
