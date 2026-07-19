/**
 * phenix-kernel — index
 *
 * Shared vocabulary only. No routing, workflow, contracts,
 * or subagent implementation logic.
 */

// Agent vocabulary
export type {
  AgentKind,
  AgentRole,
} from "./agents.ts";
export {
  AGENT_KINDS,
  isAgentKind,
  isAgentRole,
} from "./agents.ts";
// Diagnostics
export type {
  ConfigDiagnostic,
  DiagnosticSeverity,
  LinkDiagnostic,
} from "./diagnostics.ts";
// Execution protocol
export type {
  AgentExecutionMode,
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutionIssue,
  WorkflowExecutionBinding,
} from "./execution.ts";
// Branded IDs
export type {
  AgentClientId,
  AgentKindId,
  Brand,
  CapabilityId,
  ContractDefinitionId,
  ContractInstanceId,
  ModelSetId,
  RunId,
  WorkflowActorId,
  WorkflowDefinitionId,
  WorkflowInstanceId,
  WorkflowStateId,
  WorkflowTransitionId,
} from "./ids.ts";
export {
  agentClientId,
  agentKindId,
  capabilityId,
  contractDefinitionId,
  contractInstanceId,
  modelSetId,
  runId,
  workflowActorId,
  workflowDefinitionId,
  workflowInstanceId,
  workflowStateId,
  workflowTransitionId,
} from "./ids.ts";
// Typed symbolic references
export type {
  AgentClientRef,
  AgentKindRef,
  CapabilityRef,
  ContractDefinitionRef,
  ModelSetRef,
  ResourceKind,
  ResourceRef,
  WorkflowRef,
} from "./refs.ts";
export {
  agentClientRef,
  agentKindRef,
  capabilityRef,
  contractRef,
  modelSetRef,
  refEquals,
  workflowRef,
} from "./refs.ts";
// Task semantics
export type {
  Difficulty,
  ProfileHint,
  TaskProfile,
  ThinkingLevel,
} from "./task.ts";
export {
  ALL_DIFFICULTIES,
  deriveTaskProfileFromText,
  difficultyForProfile,
  isDifficulty,
  isThinkingLevel,
} from "./task.ts";
