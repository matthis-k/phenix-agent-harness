import type { AgentLimits } from "../domain/definition/definition.ts";
import type { BudgetMode } from "../domain/definition/effort.ts";
import type { PiThinkingLevel } from "../domain/definition/model.ts";

export interface BudgetPolicy {
  applyAgentLimits(base: AgentLimits, budget: BudgetMode): AgentLimits;
  capThinking(requested: PiThinkingLevel, budget: BudgetMode): PiThinkingLevel;
}

export const passthroughBudgetPolicy: BudgetPolicy = Object.freeze({
  applyAgentLimits: (base) => base,
  capThinking: (requested) => requested,
});
