import { createHash } from "node:crypto";
import type { Difficulty } from "../phenix-kernel/task.ts";
import { resolveDelegationOptions } from "./delegation-options.ts";
import {
  assertUniqueWorkflowAgentNames,
  workflowAgentName,
} from "./workflow-action-names.ts";
import type {
  DelegationAuthority,
  DelegationOption,
  WorkflowDefinition,
  WorkflowHandleRecord,
  WorkflowOutputSchemaId,
  WorkflowRuntimeRecord,
} from "./workflow-types.ts";

/** Internal projection used to bind a model-facing action to workflow authority. */
export interface ModelDelegationOption {
  /** Actor-scoped name accepted by the workflow tool. */
  readonly agent: string;
  /** Stable internal transition identity. Never required from the model. */
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
  const projected = options.map((option) => {
    const role = option.role ?? "base";
    return {
      agent: workflowAgentName({ transitionId: option.transitionId, role }),
      transitionId: option.transitionId,
      workflowRevision: option.workflowRevision,
      role,
      purpose: option.purpose,
      description: option.description,
      category: option.category,
      outputSchemaId: option.outputSchemaId,
      allowedModes: [...option.allowedModes],
      resultSchema: option.outputSchema,
    };
  });

  assertUniqueWorkflowAgentNames(projected);
  return projected;
}

export function computeOptionsDigest(options: readonly ModelDelegationOption[]): string {
  const canonical = [...options]
    .sort((left, right) => left.transitionId.localeCompare(right.transitionId))
    .map((option) => ({
      agent: option.agent,
      transitionId: option.transitionId,
      workflowRevision: option.workflowRevision,
      role: option.role,
      allowedModes: [...(option.allowedModes ?? [])].sort(),
      outputSchemaId: option.outputSchemaId,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function buildWorkflowDecisionContext(input: {
  readonly definition: WorkflowDefinition;
  readonly runtime: WorkflowRuntimeRecord;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly WorkflowHandleRecord[];
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

export function formatWorkflowProjection(projection: ModelWorkflowProjection): string {
  const lines = [
    "## Phenix workflow authority",
    "",
    `Difficulty: ${projection.difficulty}`,
    `Current state: ${projection.currentState}`,
    `Workflow revision: ${projection.revision}`,
    "",
  ];

  if (projection.options.length === 0) {
    lines.push(
      "No delegation action is currently legal.",
      "Use phenix_workflow with action=inspect after workflow state changes; otherwise complete the current assignment using phenix_complete.",
      "",
    );
    return lines.join("\n");
  }

  lines.push("Available actor-scoped delegation actions:", "");
  for (const [index, option] of projection.options.entries()) {
    lines.push(
      `${index + 1}. ${option.agent}`,
      `   Role: ${option.role}`,
      `   Category: ${option.category}`,
      `   Purpose: ${option.description}`,
      `   Result schema: ${option.outputSchemaId}`,
      `   Modes: ${option.allowedModes.join(", ")}`,
      "",
    );
  }

  lines.push(
    "Workflow API protocol:",
    "1. Use phenix_workflow with action=inspect when fresh workflow authority is needed.",
    "2. Use phenix_workflow with action=delegate, one listed agent name, and a bounded task.",
    "The runtime resolves the local name in the current actor scope and binds the internal transition, revision, and authority digest.",
    "Do not invent a role, transition, result schema, model, thinking level, tool set, or delegation depth.",
  );
  return lines.join("\n");
}
