import { definitionId } from "../domain/shared.ts";

export const AGENT_DIFFICULTY_ESTIMATOR = definitionId("agent.difficulty-estimator");
export const AGENT_SCOUT = definitionId("agent.scout");
export const AGENT_REPRODUCER = definitionId("agent.reproducer");
export const AGENT_RESEARCHER = definitionId("agent.researcher");
export const AGENT_THREAT_MODELER = definitionId("agent.threat-modeler");
export const AGENT_IMPLEMENTER = definitionId("agent.implementer");
export const AGENT_PLANNER = definitionId("agent.planner");
export const AGENT_ARCHITECT = definitionId("agent.architect");
export const AGENT_TESTER = definitionId("agent.tester");
export const AGENT_VERIFIER = definitionId("agent.verifier");
export const AGENT_CRITIC = definitionId("agent.critic");
export const AGENT_FINALIZER = definitionId("agent.finalizer");
export const AGENT_DISPATCHER = definitionId("agent.dispatcher");
export const AGENT_COORDINATOR = definitionId("agent.coordinator");
export const AGENT_BASE = definitionId("agent.base");
export const SESSION_STOCK = definitionId("session.stock");
export const AGENT_QA_SYNTHESIZER = definitionId("agent.qa-synthesizer");
export const AGENT_ATTENTION_ROUTER = definitionId("agent.attention-router");

export const WORKFLOW_DEBUG = definitionId("workflow.debug");
export const WORKFLOW_DESIGN = definitionId("workflow.design");
export const WORKFLOW_IMPLEMENT = definitionId("workflow.implement");
export const WORKFLOW_MIGRATE = definitionId("workflow.migrate");
export const WORKFLOW_QA = definitionId("workflow.qa");
export const WORKFLOW_REFACTOR = definitionId("workflow.refactor");
export const WORKFLOW_RESEARCH = definitionId("workflow.research");
export const WORKFLOW_REVIEW = definitionId("workflow.review");
export const WORKFLOW_SECURITY = definitionId("workflow.security");
export const WORKFLOW_UI_CHANGE = definitionId("workflow.ui-change");

export const AGENT_DEFINITION_IDS = [
  AGENT_DIFFICULTY_ESTIMATOR,
  AGENT_SCOUT,
  AGENT_REPRODUCER,
  AGENT_RESEARCHER,
  AGENT_THREAT_MODELER,
  AGENT_IMPLEMENTER,
  AGENT_PLANNER,
  AGENT_ARCHITECT,
  AGENT_TESTER,
  AGENT_VERIFIER,
  AGENT_CRITIC,
  AGENT_FINALIZER,
  AGENT_DISPATCHER,
  AGENT_COORDINATOR,
  AGENT_BASE,
  SESSION_STOCK,
  AGENT_QA_SYNTHESIZER,
  AGENT_ATTENTION_ROUTER,
] as const;

export const WORKFLOW_DEFINITION_IDS = [
  WORKFLOW_DEBUG,
  WORKFLOW_DESIGN,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_MIGRATE,
  WORKFLOW_QA,
  WORKFLOW_REFACTOR,
  WORKFLOW_RESEARCH,
  WORKFLOW_REVIEW,
  WORKFLOW_SECURITY,
  WORKFLOW_UI_CHANGE,
] as const;

export const ROOT_DISPATCH_DEFINITION_IDS = [
  AGENT_DISPATCHER,
  AGENT_COORDINATOR,
  WORKFLOW_DEBUG,
  WORKFLOW_DESIGN,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_MIGRATE,
  WORKFLOW_QA,
  WORKFLOW_REFACTOR,
  WORKFLOW_RESEARCH,
  WORKFLOW_REVIEW,
  WORKFLOW_SECURITY,
  WORKFLOW_UI_CHANGE,
] as const;

export const ROOT_INTERNAL_DEFINITION_IDS = [
  AGENT_ATTENTION_ROUTER,
  AGENT_DIFFICULTY_ESTIMATOR,
] as const;

export const ALL_DEFINITION_IDS = [
  ...AGENT_DEFINITION_IDS,
  ...WORKFLOW_DEFINITION_IDS,
] as const;

export type PhenixAgentDefinitionId = (typeof AGENT_DEFINITION_IDS)[number];
export type PhenixWorkflowDefinitionId = (typeof WORKFLOW_DEFINITION_IDS)[number];
export type PhenixDefinitionId = (typeof ALL_DEFINITION_IDS)[number];
export type RootDispatchDefinitionId = (typeof ROOT_DISPATCH_DEFINITION_IDS)[number];
export type RootInternalDefinitionId = (typeof ROOT_INTERNAL_DEFINITION_IDS)[number];
export type RootInvokableDefinitionId = RootDispatchDefinitionId | RootInternalDefinitionId;
