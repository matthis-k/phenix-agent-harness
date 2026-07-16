/**
 * child-session-backend — supported child-session construction boundary
 *
 * Phenix currently supports one real child-session mechanism: an independent
 * Pi AgentSession created through the SDK in the current Node process. Keeping
 * this factory small preserves an explicit composition boundary without
 * advertising an unusable alternative backend or duplicating the public API
 * barrel from `phenix-runtime/index.ts`.
 */

import type { ChildSessionBackend, PiRuntimeServices } from "./child-session-types.ts";
import type {
  PiSessionFactory,
  PiSessionLike,
  PreparedPiSessionSpec,
  PromptOptions,
  SdkChildSessionBackendOptions,
} from "./sdk-child-session-backend.ts";
import {
  buildEffectiveToolNames,
  ProductionPiSessionFactory,
  SdkChildSessionBackend,
} from "./sdk-child-session-backend.ts";

export type ChildSessionBackendOptions = SdkChildSessionBackendOptions;

export function createChildSessionBackend(
  options: ChildSessionBackendOptions,
): ChildSessionBackend {
  return new SdkChildSessionBackend(options);
}

// Composition convenience only. Callers of the public subagent API should
// import requests, routing selectors, return contracts, and managers from
// `phenix-runtime/index.ts`.
export type { SubagentSessionRuntimeOptions } from "./subagent-session-runtime.ts";
export {
  createSubagentSessionRuntime,
  SubagentSessionPlanner,
  SubagentSessionRuntime,
} from "./subagent-session-runtime.ts";

export type {
  ChildSessionBackend,
  PiRuntimeServices,
  PiSessionFactory,
  PiSessionLike,
  PreparedPiSessionSpec,
  PromptOptions,
  SdkChildSessionBackendOptions,
};

export { buildEffectiveToolNames, ProductionPiSessionFactory, SdkChildSessionBackend };
