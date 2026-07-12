import { createHash } from "node:crypto";

import type {
  DelegationAuthority,
  DelegationOption,
  WorkflowDefinition,
  WorkflowOutputSchemaId,
  WorkflowRuntimeRecord,
} from "./workflow-types.ts";
import type { HandleRecord } from "../phenix-subagents/handle-types.ts";
import type { Difficulty } from "../phenix-routing/types.ts";
import { resolveDelegationOptions } from "./delegation-options.ts";

export interface ModelDelegationOption {
  readonly transitionId: string;
  readonly workflowRevision: number;
  readonly role: string;
  readonly purpose: string;
  readonly description: string;
  readonly category: "required" | "optional" | "repair";
  readonly outputSchemaId: WorkflowOutputSchemaId;
  readonly allowedModes: ReadonlyArray<"await" | "background">;
  readonly resultSchema: Record<string, unknown>;
}

export interface ModelWorkflowProjection {
  readonly difficulty: Difficulty;
  readonly currentState: string;
  readonly revision: number;
  readonly optionsDigest: string;
  readonly options: readonly ModelDelegationOption[];
}

export interface WorkflowDecisionContext extends ModelWorkflowProjection {}

export function projectDelegationOptions(
  options: readonly DelegationOption[],
): readonly ModelDelegationOption[] {
  return options.map((option) => ({
    transitionId: option.transitionId,
    workflowRevision: option.workflowRevision,
    role: option.role ?? "base",
    purpose: option.purpose,
    description: option.description,
    category: option.category,
    outputSchemaId: option.outputSchemaId,
    allowedModes: [...option.allowedModes],
    resultSchema: option.outputSchema,
  }));
}

export function computeOptionsDigest(
  options: readonly ModelDelegationOption[],
): string {
  const canonical = [...options]
    .sort((left, right) => left.transitionId.localeCompare(right.transitionId))
    .map((option) => ({
      transitionId: option.transitionId,
      workflowRevision: option.workflowRevision,
      role: option.role,
      allowedModes: [...(option.allowedModes ?? [])].sort(),
      outputSchemaId: option.outputSchemaId,
    }));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

export function buildWorkflowDecisionContext(input: {
  readonly definition: WorkflowDefinition;
  readonly runtime: WorkflowRuntimeRecord;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly HandleRecord[];
}): WorkflowDecisionContext {
  const options = projectDelegationOptions(resolveDelegationOptions(input));
  return {
    difficulty: input.runtime.difficulty,
    currentState: input.runtime.state,
    revision: input.runtime.revision,
    optionsDigest: computeOptionsDigest(options),
    options,
  };
}

export function buildRootWorkflowProjection(
  input: Parameters<typeof buildWorkflowDecisionContext>[0],
): ModelWorkflowProjection {
  return buildWorkflowDecisionContext(input);
}

export function buildChildWorkflowProjection(
  input: Parameters<typeof buildWorkflowDecisionContext>[0],
): ModelWorkflowProjection {
  return buildWorkflowDecisionContext(input);
}

export function formatWorkflowProjection(
  projection: ModelWorkflowProjection,
): string {
  const lines = [
    "## Phenix workflow authority",
    "",
    `Difficulty: ${projection.difficulty}`,
    `Current state: ${projection.currentState}`,
    `Workflow revision: ${projection.revision}`,
    `Authority digest: ${projection.optionsDigest}`,
    "",
  ];

  if (projection.options.length === 0) {
    lines.push(
      "No delegation transition is currently legal.",
      "Complete the current assignment using phenix_complete.",
      "",
    );
    return lines.join("\n");
  }

  lines.push("You may currently delegate only through these transitions:", "");
  for (const [index, option] of projection.options.entries()) {
    lines.push(
      `${index + 1}. ${option.transitionId}`,
      `   Role: ${option.role}`,
      `   Category: ${option.category}`,
      `   Purpose: ${option.description}`,
      `   Result schema: ${option.outputSchemaId}`,
      `   Modes: ${option.allowedModes.join(", ")}`,
      "",
    );
  }

  lines.push(
    "Call phenix_delegate with exactly:",
    "- transitionId: one transition ID listed above",
    "- workflowRevision: the workflow revision shown above",
    "- authorityDigest: the authority digest shown above",
    "- task: the bounded objective for the child",
    "- optional: requirements, tools narrowing, delegateRoles narrowing, mode",
    "",
    "Do not invent a role, transition, result schema, model, or thinking level.",
  );
  return lines.join("\n");
}
