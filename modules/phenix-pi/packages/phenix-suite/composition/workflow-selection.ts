import type { Difficulty } from "@matthis-k/phenix-kernel/task.ts";

import {
  PHENIX_GENERAL_WORKFLOW,
  PHENIX_IMPLEMENT_WORKFLOW,
  PHENIX_QA_WORKFLOW,
} from "../defaults/workflow-presets.ts";

export type WorkflowPreset = "general" | "implement" | "qa";
export type WorkflowSelectionSource = "explicit" | "classifier" | "fallback";

export interface WorkflowSelection {
  readonly preset: WorkflowPreset;
  readonly workflowDefinitionId: string;
  readonly source: WorkflowSelectionSource;
  readonly reason: string;
}

const PRESET_DEFINITION_IDS: Readonly<Record<WorkflowPreset, string>> = {
  general: PHENIX_GENERAL_WORKFLOW.id,
  implement: PHENIX_IMPLEMENT_WORKFLOW.id,
  qa: PHENIX_QA_WORKFLOW.id,
};

const DIFFICULTY_ORDER: readonly Difficulty[] = ["D0", "D1", "D2", "D3"];

function explicitPreset(message: string): WorkflowPreset | undefined {
  const match = /(?:^|\s)(?:workflow|preset)\s*[:=]\s*(general|implement|qa)\b/i.exec(message);
  return match?.[1]?.toLowerCase() as WorkflowPreset | undefined;
}

function hasQaIntent(message: string): boolean {
  return [
    /\bqa\b/i,
    /\bquality[- ]assurance\b/i,
    /\b(?:full|complete|thorough|comprehensive)\s+(?:code\s+)?review\b/i,
    /\b(?:review|audit|assess)\s+(?:this|the)?\s*(?:repo(?:sitory)?|codebase|module|branch)\b/i,
  ].some((pattern) => pattern.test(message));
}

function hasImplementationIntent(message: string): boolean {
  return /\b(?:implement|fix|patch|add|remove|rename|replace|change|update|refactor|migrate|merge|clean\s*up|address)\b/i.test(
    message,
  );
}

function hasReviewFindingFixIntent(message: string): boolean {
  const mentionsReview = /\b(?:qa|quality[- ]assurance|review|audit)\b/i.test(message);
  const mentionsExistingFindings =
    /\b(?:finding|findings|defect|defects|report|reported|discovered)\b/i.test(message) ||
    /\bissues?\b.*\b(?:discovered|reported|found)\b/i.test(message) ||
    /\b(?:discovered|reported|found)\b.*\bissues?\b/i.test(message);
  return hasImplementationIntent(message) && mentionsReview && mentionsExistingFindings;
}

function presetForDefinitionId(definitionId: string): WorkflowPreset | undefined {
  return (Object.entries(PRESET_DEFINITION_IDS) as ReadonlyArray<[WorkflowPreset, string]>).find(
    ([, id]) => id === definitionId,
  )?.[0];
}

export function selectWorkflow(input: {
  readonly userMessage: string;
  readonly fallbackWorkflowDefinitionId: string;
}): WorkflowSelection {
  const explicit = explicitPreset(input.userMessage);
  if (explicit) {
    return {
      preset: explicit,
      workflowDefinitionId: PRESET_DEFINITION_IDS[explicit],
      source: "explicit",
      reason: `The user explicitly selected the ${explicit} workflow preset.`,
    };
  }

  if (hasReviewFindingFixIntent(input.userMessage)) {
    return {
      preset: "implement",
      workflowDefinitionId: PRESET_DEFINITION_IDS.implement,
      source: "classifier",
      reason:
        "The request asks to implement fixes for existing QA/review findings, not to run a new QA review.",
    };
  }

  if (hasQaIntent(input.userMessage)) {
    return {
      preset: "qa",
      workflowDefinitionId: PRESET_DEFINITION_IDS.qa,
      source: "classifier",
      reason: "The request explicitly asks for quality assurance or repository review.",
    };
  }

  if (hasImplementationIntent(input.userMessage)) {
    return {
      preset: "implement",
      workflowDefinitionId: PRESET_DEFINITION_IDS.implement,
      source: "classifier",
      reason: "The request contains an implementation or code-change action.",
    };
  }

  return {
    preset: presetForDefinitionId(input.fallbackWorkflowDefinitionId) ?? "general",
    workflowDefinitionId: input.fallbackWorkflowDefinitionId,
    source: "fallback",
    reason: "No specialized workflow intent was detected; using the configured fallback.",
  };
}

function maxDifficulty(left: Difficulty, right: Difficulty): Difficulty {
  const index = Math.max(DIFFICULTY_ORDER.indexOf(left), DIFFICULTY_ORDER.indexOf(right));
  return DIFFICULTY_ORDER[index] ?? right;
}

export function difficultyForWorkflow(input: {
  readonly selected: Difficulty;
  readonly workflow: WorkflowSelection;
  readonly userMessage: string;
}): Difficulty {
  if (input.workflow.preset !== "qa") return input.selected;

  const repositoryWide =
    /\b(?:full|complete|thorough|comprehensive)\b/i.test(input.userMessage) ||
    /\b(?:repo(?:sitory)?|codebase)\b/i.test(input.userMessage);
  return maxDifficulty(input.selected, repositoryWide ? "D3" : "D2");
}
