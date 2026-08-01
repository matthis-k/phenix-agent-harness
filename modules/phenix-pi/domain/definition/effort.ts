export const EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** User-authorized execution budget for Phenix-routed sessions. */
export type BudgetMode = EffortLevel;

export function isBudgetMode(value: string): value is BudgetMode {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function effortIndex(value: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(value);
}
