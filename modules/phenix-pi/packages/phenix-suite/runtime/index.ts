/** Public Phenix subagent API and canonical execution-plan vocabulary. */

export type {
  AcceptanceEngine,
  AcceptancePlan,
  RuntimeBindings,
  SubagentExecutionCompiler,
  SubagentExecutionPlan,
} from "./execution-plan.ts";
export type {
  ConcreteSessionModel,
  RoutedSessionModel,
  RoutedSessionModelOptions,
  SessionModelSelector,
  SessionPersistence,
  SubagentSessionOptions,
} from "./session-options.ts";
export { routing } from "./session-options.ts";
export type {
  SessionSubagentExecutionAdapterOptions,
  SubagentSessionSpawner,
} from "./session-subagent-adapter.ts";
export {
  createSessionSubagentExecutionAdapter,
  SessionSubagentExecutionAdapter,
} from "./session-subagent-adapter.ts";
export type {
  ReturnSpec,
  ReturnSpecMetadata,
  ReturnSpecOptions,
  SubagentRequest,
} from "./subagent-api.ts";
export { decodeReturnValue, returns, returnsWithDecoder } from "./subagent-api.ts";
export type {
  ActiveSubagentCountListener,
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
