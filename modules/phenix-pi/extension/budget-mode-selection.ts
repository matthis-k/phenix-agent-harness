import {
  isBudgetMode,
  type BudgetMode,
} from "../domain/definition/effort.ts";

export const BUDGET_MODE_SELECTION_EVENT = "phenix:budget-mode-selection";

export interface BudgetModeEventBus {
  readonly on: (event: string, listener: (value: unknown) => void) => unknown;
  readonly emit: (event: string, value: unknown) => unknown;
}

export function publishBudgetModeSelection(events: BudgetModeEventBus, budget: BudgetMode): void {
  events.emit(BUDGET_MODE_SELECTION_EVENT, budget);
}

export function subscribeBudgetModeSelection(
  events: BudgetModeEventBus,
  listener: (budget: BudgetMode) => void,
): void {
  events.on(BUDGET_MODE_SELECTION_EVENT, (value) => {
    if (typeof value === "string" && isBudgetMode(value)) listener(value);
  });
}
