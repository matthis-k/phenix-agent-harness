/**
 * child-session-backend — supported child-session construction boundary
 *
 * Phenix currently supports one real child-session mechanism: an independent
 * Pi AgentSession created through the SDK in the current Node process. Keeping
 * this factory small preserves an explicit composition boundary without
 * advertising an unusable alternative backend.
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

/** Options accepted by the sole supported child-session backend. */
export type ChildSessionBackendOptions = SdkChildSessionBackendOptions;

/** Construct the supported SDK child-session backend. */
export function createChildSessionBackend(
  options: ChildSessionBackendOptions,
): ChildSessionBackend {
  return new SdkChildSessionBackend(options);
}

export type {
  ChildSessionBackend,
  PiRuntimeServices,
  PiSessionFactory,
  PiSessionLike,
  PreparedPiSessionSpec,
  PromptOptions,
  SdkChildSessionBackendOptions,
};

export type {
  ConcreteSessionModel,
  ResolvedSubagentSessionOptions,
  RoutedSessionModel,
  RoutedSessionModelOptions,
  SessionModelSelector,
  SessionPersistence,
  SessionRouteRequest,
  SessionRouteResolution,
  SessionRouteResolver,
  SubagentSessionDefaults,
  SubagentSessionOptions,
} from "./session-options.ts";
export { resolveSubagentSessionOptions, routing } from "./session-options.ts";

export { buildEffectiveToolNames, ProductionPiSessionFactory, SdkChildSessionBackend };
