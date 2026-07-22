/** Supported child-session composition boundary. */

import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionSpec,
  PiRuntimeServices,
} from "./child-session-types.ts";
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
import type { PiRuntimeAdapter } from "./runtime-adapter.ts";
import { SelectingChildSessionBackend } from "./runtime-adapter.ts";
import type { RpcChildSessionBackendOptions } from "./rpc-child-session-backend.ts";
import { RpcChildSessionBackend } from "./rpc-child-session-backend.ts";
import { TimedChildSessionBackend } from "./timed-child-session-backend.ts";
import { WorkflowScopedPiSessionFactory } from "./workflow-session-factory.ts";

export interface ChildSessionBackendOptions extends SdkChildSessionBackendOptions {
  readonly rpc?: Omit<RpcChildSessionBackendOptions, "agentDir">;
}

function sdkAdapter(options: ChildSessionBackendOptions): PiRuntimeAdapter {
  const backend = new SdkChildSessionBackend({
    ...options,
    sessionFactory: new WorkflowScopedPiSessionFactory(options.sessionFactory),
  });
  return {
    kind: "sdk",
    supports: () => true,
    start: (spec: ChildSessionSpec, signal: AbortSignal): Promise<ChildRun> =>
      backend.start(spec, signal),
  };
}

export function createChildSessionBackend(
  options: ChildSessionBackendOptions,
): ChildSessionBackend {
  const rpc = new RpcChildSessionBackend({
    agentDir: options.services.agentDir,
    ...(options.rpc ?? {}),
  });
  return new TimedChildSessionBackend(
    new SelectingChildSessionBackend([rpc, sdkAdapter(options)]),
  );
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
  SubagentQuery,
  SubagentSnapshot,
  SubagentStatus,
} from "./subagent-manager.ts";
export {
  createSubagentManager,
  SubagentExecutionError,
  SubagentHandleDirectory,
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
export {
  normalizeWorkflowRuntimeToolNames,
  WorkflowScopedPiSessionFactory,
} from "./workflow-session-factory.ts";
export type {
  ChildSessionBackend,
  PiRuntimeServices,
  PiSessionFactory,
  PiSessionLike,
  PreparedPiSessionSpec,
  PromptOptions,
  RpcChildSessionBackendOptions,
  SdkChildSessionBackendOptions,
};
export {
  buildEffectiveToolNames,
  ProductionPiSessionFactory,
  RpcChildSessionBackend,
  SdkChildSessionBackend,
  TimedChildSessionBackend,
};
