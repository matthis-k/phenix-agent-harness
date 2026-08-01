import type { AgentLimits } from "../domain/definition/definition.ts";
import type { BudgetMode } from "../domain/definition/effort.ts";
import type { PiThinkingLevel } from "../domain/definition/model.ts";
import type { RunLimits } from "../domain/run/model.ts";

export interface BudgetPolicy {
  applyAgentLimits(base: AgentLimits, budget: BudgetMode): RunLimits;
  capThinking(requested: PiThinkingLevel, budget: BudgetMode): PiThinkingLevel;
}

export const passthroughBudgetPolicy: BudgetPolicy = Object.freeze({
  applyAgentLimits: (base: AgentLimits) => base,
  capThinking: (requested: PiThinkingLevel) => requested,
});
