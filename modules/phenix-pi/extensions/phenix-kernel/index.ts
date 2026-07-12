/**
 * phenix-kernel — index
 *
 * Shared vocabulary only. No routing, workflow, contracts,
 * or subagent implementation logic.
 */

// Branded IDs
export type {
  Brand,
  AgentKindId,
  AgentClientId,
  ContractDefinitionId,
  ContractInstanceId,
  WorkflowDefinitionId,
  WorkflowStateId,
  WorkflowTransitionId,
  WorkflowInstanceId,
  WorkflowActorId,
  ModelSetId,
  CapabilityId,
  RunId,
} from "./ids.ts";

export {
  agentKindId,
  agentClientId,
  contractDefinitionId,
  contractInstanceId,
  workflowDefinitionId,
  workflowStateId,
  workflowTransitionId,
  workflowInstanceId,
  workflowActorId,
  modelSetId,
  capabilityId,
  runId,
} from "./ids.ts";

// Typed symbolic references
export type {
  ResourceKind,
  ResourceRef,
  AgentClientRef,
  AgentKindRef,
  ContractDefinitionRef,
  WorkflowRef,
  ModelSetRef,
  CapabilityRef,
} from "./refs.ts";

export {
  agentClientRef,
  agentKindRef,
  contractRef,
  workflowRef,
  modelSetRef,
  capabilityRef,
  refEquals,
} from "./refs.ts";

// Task semantics
export type {
  Difficulty,
  ThinkingLevel,
  TaskProfile,
  ProfileHint,
} from "./task.ts";

export {
  ALL_DIFFICULTIES,
  isDifficulty,
  isThinkingLevel,
  deriveTaskProfileFromText,
  difficultyForProfile,
} from "./task.ts";

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

// Execution protocol
export type {
  AgentExecutionMode,
  WorkflowExecutionBinding,
  AgentExecutionRequest,
  ExecutionIssue,
  AgentExecutionResult,
  AgentExecutionPort,
  AgentSessionId,
  AgentSessionStatus,
  AgentSessionExecutionBackend,
  AgentSessionContractRef,
  AgentSessionContext,
  AgentSessionNode,
  AgentSessionResult,
} from "./execution.ts";

export { agentSessionId } from "./execution.ts";

// Diagnostics
export type {
  DiagnosticSeverity,
  LinkDiagnostic,
  ConfigDiagnostic,
} from "./diagnostics.ts";
