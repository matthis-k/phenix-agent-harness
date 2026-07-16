/**
 * Phenix Workflow Module — index
 *
 * Deterministic TypeScript-owned workflow and delegation authority system.
 */

// Agent capabilities
export type {
  AgentCapabilityArtifact,
  AgentCapabilityEntry,
} from "./agent-capabilities.ts";
export {
  buildCapabilityArtifact,
  capabilityArtifactPath,
  configuredAgent,
  DEFAULT_AGENT_TARGETS,
  isSpawnableAgent,
  persistCapabilityArtifact,
  readCapabilityArtifact,
} from "./agent-capabilities.ts";
// Capability provider
export type {
  AgentDiscoveryHelper,
  DiscoveredAgentDefinition,
} from "./capability-provider.ts";
export {
  BuiltinAgentDiscovery,
  getAgentDiscoveryHelper,
  setAgentDiscoveryHelper,
} from "./capability-provider.ts";
// Delegation options
export { resolveDelegationOptions } from "./delegation-options.ts";
export type { SessionWorkflowData } from "./session-registry.ts";
// Session registry
export {
  activeSessionCount,
  clearAllSessions,
  getSessionCapabilityArtifact,
  getSessionWorkflowData,
  registerSession,
  requireSessionCapabilityArtifact,
  requireSessionWorkflowData,
  unregisterSession,
} from "./session-registry.ts";
// Conditions
export { conditionSatisfied } from "./workflow-conditions.ts";
// Definitions
export {
  getWorkflowDefinition,
  PHENIX_DEFAULT_WORKFLOW,
  validateDefinition,
} from "./workflow-definitions.ts";
// Projection
export type {
  ModelDelegationOption,
  ModelWorkflowProjection,
  WorkflowDecisionContext,
} from "./workflow-projection.ts";
export {
  buildChildWorkflowProjection,
  buildRootWorkflowProjection,
  buildWorkflowDecisionContext,
  computeOptionsDigest,
  formatWorkflowProjection,
  projectDelegationOptions,
} from "./workflow-projection.ts";
// Reducer
export {
  advanceWorkflowState,
  factsFromTransitionResult,
  isTerminalState,
  transitionMatchesDifficulty,
} from "./workflow-reducer.ts";
// Workflow runtime service
export type {
  WorkflowActorSource,
  WorkflowRuntimeDependencies,
} from "./workflow-runtime.ts";
export {
  applyAutomaticTransitions,
  buildWorkflowRuntimeDependencies,
  finalizeHandleWorkflow,
  initialWorkflowStateForRole,
  transitionAuthorityForChild,
} from "./workflow-runtime.ts";
// Schemas
export {
  ARCHITECTURE_HANDOFF_SCHEMA,
  BASE_HANDOFF_SCHEMA,
  CRITIC_HANDOFF_SCHEMA,
  FINALIZER_HANDOFF_SCHEMA,
  getOutputSchema,
  IMPLEMENTATION_HANDOFF_SCHEMA,
  OUTPUT_SCHEMAS,
  PLANNER_HANDOFF_SCHEMA,
  SCOUT_HANDOFF_SCHEMA,
  TEST_HANDOFF_SCHEMA,
} from "./workflow-schemas.ts";
// Store
export {
  acceptTransition,
  beginTransition,
  createWorkflowRecord,
  hashCapabilityContent,
  now,
  readWorkflowRecord,
  rejectTransition,
} from "./workflow-store.ts";
// Target agent identities
export {
  delegateTransitionById,
  targetAgentForTransition,
  validateTargetAgentDeterminism,
} from "./workflow-target-agents.ts";
// Types
export type {
  ActiveWorkflowTransition,
  AutomaticTransition,
  CompletedWorkflowTransition,
  DefaultWorkflowDefinitionId,
  DelegateTransition,
  DelegationAuthority,
  DelegationOption,
  DelegationPurpose,
  TransitionCondition,
  WorkflowConditionContext,
  WorkflowDefinition,
  WorkflowOutputSchemaId,
  WorkflowRuntimeRecord,
  WorkflowStateId,
  WorkflowTransition,
  WorkflowTransitionId,
} from "./workflow-types.ts";
export { mkTransitionId } from "./workflow-types.ts";
