import type { AgentDefinition, ContextPolicy } from "../domain/definition/definition.ts";
import {
  architectDefinition as rawArchitectDefinition,
  baseDefinition as rawBaseDefinition,
  coordinatorDefinition as rawCoordinatorDefinition,
  criticDefinition as rawCriticDefinition,
  dispatcherDefinition as rawDispatcherDefinition,
  finalizerDefinition as rawFinalizerDefinition,
  implementerDefinition as rawImplementerDefinition,
  plannerDefinition as rawPlannerDefinition,
  qaSynthesizerDefinition as rawQaSynthesizerDefinition,
  scoutDefinition as rawScoutDefinition,
  testerDefinition as rawTesterDefinition,
  verifierDefinition as rawVerifierDefinition,
} from "./agents/index.ts";

const fullRepositoryContext: ContextPolicy = {
  projectFiles: "inherit",
  parentConversation: "none",
  artifacts: [],
  maxBytes: 128_000,
};

const analysisRepositoryContext: ContextPolicy = {
  projectFiles: "inherit",
  parentConversation: "none",
  artifacts: [],
  maxBytes: 64_000,
};

const testRepositoryContext: ContextPolicy = {
  projectFiles: "inherit",
  parentConversation: "none",
  artifacts: [],
  maxBytes: 32_000,
};

const noProjectContext: ContextPolicy = {
  projectFiles: "none",
  parentConversation: "none",
  artifacts: [],
  maxBytes: 0,
};

function withContext<I, O>(
  definition: AgentDefinition<I, O>,
  context: ContextPolicy,
): AgentDefinition<I, O> {
  return { ...definition, context };
}

export const scoutDefinition = withContext(rawScoutDefinition, analysisRepositoryContext);
export const plannerDefinition = withContext(rawPlannerDefinition, analysisRepositoryContext);
export const architectDefinition = withContext(rawArchitectDefinition, analysisRepositoryContext);
export const implementerDefinition = withContext(rawImplementerDefinition, fullRepositoryContext);
export const testerDefinition = withContext(rawTesterDefinition, testRepositoryContext);
export const verifierDefinition = withContext(rawVerifierDefinition, fullRepositoryContext);
export const criticDefinition = withContext(rawCriticDefinition, analysisRepositoryContext);
export const finalizerDefinition = withContext(rawFinalizerDefinition, noProjectContext);
export const dispatcherDefinition = withContext(rawDispatcherDefinition, noProjectContext);
export const coordinatorDefinition = withContext(rawCoordinatorDefinition, noProjectContext);
export const baseDefinition = withContext(rawBaseDefinition, fullRepositoryContext);
export const qaSynthesizerDefinition = withContext(rawQaSynthesizerDefinition, noProjectContext);

export const agentDefinitions = [
  scoutDefinition,
  plannerDefinition,
  architectDefinition,
  implementerDefinition,
  testerDefinition,
  verifierDefinition,
  criticDefinition,
  finalizerDefinition,
  dispatcherDefinition,
  coordinatorDefinition,
  baseDefinition,
  qaSynthesizerDefinition,
] as const;
