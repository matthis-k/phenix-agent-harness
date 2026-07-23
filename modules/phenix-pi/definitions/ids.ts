import { definitionId } from "../domain/shared.ts";

export const AGENT_SCOUT = definitionId("agent.scout");
export const AGENT_IMPLEMENTER = definitionId("agent.implementer");
export const AGENT_PLANNER = definitionId("agent.planner");
export const AGENT_VERIFIER = definitionId("agent.verifier");
export const AGENT_CRITIC = definitionId("agent.critic");
export const AGENT_BASE = definitionId("agent.base");
export const AGENT_QA_SYNTHESIZER = definitionId("agent.qa-synthesizer");

export const WORKFLOW_DIRECT = definitionId("workflow.direct");
export const WORKFLOW_IMPLEMENT = definitionId("workflow.implement");
export const WORKFLOW_QA = definitionId("workflow.qa");
export const WORKFLOW_QA_FIX = definitionId("workflow.qa-and-fix");
export const WORKFLOW_DYNAMIC = definitionId("workflow.dynamic");

export const ALL_DEFINITION_IDS = [
  AGENT_SCOUT,
  AGENT_IMPLEMENTER,
  AGENT_PLANNER,
  AGENT_VERIFIER,
  AGENT_CRITIC,
  AGENT_BASE,
  AGENT_QA_SYNTHESIZER,
  WORKFLOW_DIRECT,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_QA,
  WORKFLOW_QA_FIX,
  WORKFLOW_DYNAMIC,
] as const;
