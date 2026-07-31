export const BUNDLED_AGENT_SOURCE_NAMES = [
  "difficulty-estimator",
  "scout",
  "reproducer",
  "researcher",
  "threat-modeler",
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
  "stock",
  "qa-synthesizer",
  "attention-router",
] as const;

export type BundledAgentSourceName = (typeof BUNDLED_AGENT_SOURCE_NAMES)[number];
