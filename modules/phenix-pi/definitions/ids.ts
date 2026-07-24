import { definitionId } from "../domain/shared.ts";

export const AGENT_SCOUT = definitionId("agent.scout");
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
export const AGENT_QA_SYNTHESIZER = definitionId("agent.qa-synthesizer");
export const AGENT_ATTENTION_ROUTER = definitionId("agent.attention-router");

export const WORKFLOW_IMPLEMENT = definitionId("workflow.implement");
export const WORKFLOW_QA = definitionId("workflow.qa");

export const ROOT_DISPATCH_DEFINITION_IDS = [
  AGENT_DISPATCHER,
  AGENT_COORDINATOR,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_QA,
] as const;

export const ROOT_INTERNAL_DEFINITION_IDS = [AGENT_ATTENTION_ROUTER] as const;

export const ALL_DEFINITION_IDS = [
  AGENT_SCOUT,
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
  AGENT_QA_SYNTHESIZER,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_QA,
] as const;
