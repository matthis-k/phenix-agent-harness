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
import { attentionRouterDefinition as rawAttentionRouterDefinition } from "./attention.ts";

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

function withTools<I, O>(
  definition: AgentDefinition<I, O>,
  ...tools: readonly string[]
): AgentDefinition<I, O> {
  return {
    ...definition,
    tools: { allow: [...new Set([...definition.tools.allow, ...tools])] },
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
export const implementerDefinition = configured(
  withTools(rawImplementerDefinition, "nix_shell"),
  fullRepositoryContext,
);
export const testerDefinition = configured(
  withPromptSuffix(
    withTools(rawTesterDefinition, "bash", "nix_shell"),
    "Treat the supplied deterministic check results as the baseline. You may run additional targeted read-only checks when the requested QA scope has an explicit coverage gap. Use nix_shell only when a required CLI is unavailable, never edit files, and report command evidence precisely.",
  ),
  testRepositoryContext,
);
export const verifierDefinition = configured(
  withTools(rawVerifierDefinition, "nix_shell"),
  fullRepositoryContext,
);
export const criticDefinition = configured(
  withTools(rawCriticDefinition, "nix_shell"),
  analysisRepositoryContext,
);
export const finalizerDefinition = configured(rawFinalizerDefinition, noProjectContext);
export const dispatcherDefinition = configured(rawDispatcherDefinition, noProjectContext, false);
export const coordinatorDefinition = configured(rawCoordinatorDefinition, noProjectContext);
export const baseDefinition = configured(
  withTools(rawBaseDefinition, "nix_shell"),
  fullRepositoryContext,
);
export const qaSynthesizerDefinition = configured(
  rawQaSynthesizerDefinition,
  noProjectContext,
  false,
);
export const attentionRouterDefinition = configured(
  rawAttentionRouterDefinition,
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
  attentionRouterDefinition,
] as const;
