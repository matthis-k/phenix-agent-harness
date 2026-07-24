export const BUNDLED_AGENT_SOURCE_NAMES = [
  "difficulty-estimator",
  "scout",
  "planner",
  "architect",
  "implementer",
  "tester",
  "verifier",
  "critic",
  "finalizer",
  "dispatcher",
  "coordinator",
  "base",
  "qa-synthesizer",
  "attention-router",
] as const;

export type BundledAgentSourceName = (typeof BUNDLED_AGENT_SOURCE_NAMES)[number];
