/**
 * Phenix Workflow Module — index
 *
 * Deterministic TypeScript-owned workflow and delegation authority system.
 */

// Types
export type {
  WorkflowDefinitionId,
  WorkflowStateId,
  WorkflowTransitionId,
  DelegationPurpose,
  TransitionCondition,
  WorkflowConditionContext,
  WorkflowTransition,
  DelegateTransition,
  AutomaticTransition,
  WorkflowDefinition,
  WorkflowOutputSchemaId,
  ActiveWorkflowTransition,
  CompletedWorkflowTransition,
  WorkflowRuntimeRecord,
  DelegationAuthority,
  DelegationOption,
} from "./workflow-types.ts";

export { mkTransitionId } from "./workflow-types.ts";

// Schemas
export {
  OUTPUT_SCHEMAS,
  getOutputSchema,
  SCOUT_HANDOFF_SCHEMA,
  PLANNER_HANDOFF_SCHEMA,
  ARCHITECTURE_HANDOFF_SCHEMA,
  IMPLEMENTATION_HANDOFF_SCHEMA,
  TEST_HANDOFF_SCHEMA,
  FINALIZER_HANDOFF_SCHEMA,
  CRITIC_HANDOFF_SCHEMA,
  BASE_HANDOFF_SCHEMA,
} from "./workflow-schemas.ts";

// Conditions
export { conditionSatisfied } from "./workflow-conditions.ts";

// Definitions
export {
  PHENIX_DEFAULT_WORKFLOW,
  getWorkflowDefinition,
  validateDefinition,
} from "./workflow-definitions.ts";

// Reducer
export {
  factsFromTransitionResult,
  advanceWorkflowState,
  isTerminalState,
  transitionMatchesDifficulty,
} from "./workflow-reducer.ts";

// Store
export {
  readWorkflowRecord,
  createWorkflowRecord,
  writeWorkflowRecord,
  beginTransition,
  acceptTransition,
  rejectTransition,
  hashCapabilityContent,
  now,
} from "./workflow-store.ts";

// Delegation options
export { resolveDelegationOptions } from "./delegation-options.ts";

// Projection
export type {
  ModelDelegationOption,
  ModelWorkflowProjection,
  WorkflowDecisionContext,
} from "./workflow-projection.ts";

export {
  projectDelegationOptions,
  buildRootWorkflowProjection,
  buildChildWorkflowProjection,
  formatWorkflowProjection,
  buildWorkflowDecisionContext,
  computeOptionsDigest,
} from "./workflow-projection.ts";

// Agent capabilities
export type {
  AgentCapabilityEntry,
  AgentCapabilityArtifact,
} from "./agent-capabilities.ts";

export {
  DEFAULT_AGENT_TARGETS,
  buildCapabilityArtifact,
  configuredAgent,
  isSpawnableAgent,
  persistCapabilityArtifact,
} from "./agent-capabilities.ts";

// Session registry
export {
  registerSession,
  unregisterSession,
  getSessionCapabilityArtifact,
  getSessionWorkflowData,
  requireSessionCapabilityArtifact,
  requireSessionWorkflowData,
  activeSessionCount,
  clearAllSessions,
} from "./session-registry.ts";

export type { SessionWorkflowData } from "./session-registry.ts";

// Workflow runtime service
export type {
  WorkflowRuntimeDependencies,
  WorkflowActorSource,
} from "./workflow-runtime.ts";

export {
  buildWorkflowRuntimeDependencies,
  initialWorkflowStateForRole,
  transitionAuthorityForChild,
  applyAutomaticTransitions,
} from "./workflow-runtime.ts";

// Capability provider
export type {
  DiscoveredAgentDefinition,
  AgentDiscoveryHelper,
} from "./capability-provider.ts";

export {
  getAgentDiscoveryHelper,
  setAgentDiscoveryHelper,
  BuiltinAgentDiscovery,
} from "./capability-provider.ts";
