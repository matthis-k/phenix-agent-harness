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

export type ChildSessionBackendOptions = SdkChildSessionBackendOptions;

export function createChildSessionBackend(
  options: ChildSessionBackendOptions,
): ChildSessionBackend {
  return new SdkChildSessionBackend(options);
}

export type {
  AcceptanceEngine,
  AcceptancePlan,
  RuntimeBindings,
  SubagentExecutionCompiler,
  SubagentExecutionPlan,
} from "./execution-plan.ts";
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
export type {
  ReturnSpec,
  ReturnSpecMetadata,
  ReturnSpecOptions,
  SubagentRequest,
} from "./subagent-api.ts";
export { decodeReturnValue, returns, returnsWithDecoder } from "./subagent-api.ts";
export type {
  SubagentCancellation,
  SubagentError,
  SubagentEvent,
  SubagentExecutionAdapter,
  SubagentHandle,
  SubagentSnapshot,
  SubagentStatus,
} from "./subagent-manager.ts";
export {
  createSubagentManager,
  SubagentExecutionError,
  SubagentManager,
} from "./subagent-manager.ts";
export type {
  SessionSubagentManagerFactoryOptions,
  SubagentManagerFactory,
} from "./subagent-manager-factory.ts";
export {
  createSessionSubagentManagerFactory,
  SessionSubagentManagerFactory,
} from "./subagent-manager-factory.ts";
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
