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

function configured<I, O>(
  definition: AgentDefinition<I, O>,
  context: ContextPolicy,
  mayPresent = true,
): AgentDefinition<I, O> {
  return {
    ...definition,
    context,
    tools: mayPresent
      ? { allow: [...new Set([...definition.tools.allow, "phenix_present"])] }
      : definition.tools,
  };
}

function withPromptSuffix<I, O>(
  definition: AgentDefinition<I, O>,
  suffix: string,
): AgentDefinition<I, O> {
  return {
    ...definition,
    prompt: { render: () => `${definition.prompt.render()}\n${suffix}` },
  };
}

export const scoutDefinition = configured(
  withPromptSuffix(
    rawScoutDefinition,
    "You have no command-execution capability. Never claim to run checks or delegate command work. If the task requires executing a command rather than inspecting existing evidence, call phenix_fail immediately with an insufficient_permissions report.",
  ),
  analysisRepositoryContext,
);
export const plannerDefinition = configured(rawPlannerDefinition, analysisRepositoryContext);
export const architectDefinition = configured(
  withPromptSuffix(
    rawArchitectDefinition,
    "In workflow QA, deterministic checks are handled by a separate tester branch. Do not rerun or delegate those checks. Delegate to agent.scout only for a focused repository evidence question that can be answered with read, grep, find, or ls.",
  ),
  analysisRepositoryContext,
);
export const implementerDefinition = configured(rawImplementerDefinition, fullRepositoryContext);
export const testerDefinition = configured(rawTesterDefinition, testRepositoryContext);
export const verifierDefinition = configured(rawVerifierDefinition, fullRepositoryContext);
export const criticDefinition = configured(rawCriticDefinition, analysisRepositoryContext);
export const finalizerDefinition = configured(rawFinalizerDefinition, noProjectContext);
export const dispatcherDefinition = configured(rawDispatcherDefinition, noProjectContext, false);
export const coordinatorDefinition = configured(rawCoordinatorDefinition, noProjectContext);
export const baseDefinition = configured(rawBaseDefinition, fullRepositoryContext);
export const qaSynthesizerDefinition = configured(
  rawQaSynthesizerDefinition,
  noProjectContext,
  false,
);

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
