/** Public Phenix subagent API. */

export type {
  ConcreteSessionModel,
  RoutedSessionModel,
  RoutedSessionModelOptions,
  SessionModelSelector,
  SessionPersistence,
  SubagentSessionOptions,
} from "./session-options.ts";
export { routing } from "./session-options.ts";
export type { ReturnSpec, ReturnSpecOptions, SubagentRequest } from "./subagent-api.ts";
export { returns } from "./subagent-api.ts";
export type {
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
