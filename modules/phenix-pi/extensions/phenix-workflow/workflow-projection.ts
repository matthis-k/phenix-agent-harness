import { createHash } from "node:crypto";
import type { Difficulty } from "../phenix-kernel/task.ts";
import { resolveDelegationOptions } from "./delegation-options.ts";
import type {
  DelegationAuthority,
  DelegationOption,
  WorkflowDefinition,
  WorkflowHandleRecord,
  WorkflowOutputSchemaId,
  WorkflowRuntimeRecord,
} from "./workflow-types.ts";

/** Internal edge projection used to bind a graph-facing workflow call. */
export interface ModelDelegationOption {
  readonly edgeId: string;
  /** Compatibility identity for runtime persistence and settlement code. */
  readonly transitionId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
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
  sourceNodeId: string,
  options: readonly DelegationOption[],
): readonly ModelDelegationOption[] {
  return options.map((option) => ({
    edgeId: option.transitionId,
    transitionId: option.transitionId,
    sourceNodeId,
    targetNodeId: option.targetState,
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

export function computeOptionsDigest(options: readonly ModelDelegationOption[]): string {
  const canonical = [...options]
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId))
    .map((option) => ({
      edgeId: option.edgeId,
      sourceNodeId: option.sourceNodeId,
      targetNodeId: option.targetNodeId,
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
  const options = projectDelegationOptions(
    input.runtime.state,
    resolveDelegationOptions(input),
  );
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
    `Current node ID: ${projection.currentState}`,
    `Difficulty: ${projection.difficulty}`,
    `Workflow revision: ${projection.revision}`,
    "",
  ];

  if (projection.options.length === 0) {
    lines.push(
      "The current node has no legal outgoing spawn edge.",
      "Use phenix_workflow with action=inspect after workflow state changes; otherwise complete the current assignment using phenix_complete.",
      "",
    );
    return lines.join("\n");
  }

  lines.push("Legal outgoing workflow edges:", "");
  for (const [index, option] of projection.options.entries()) {
    lines.push(
      `${index + 1}. Edge ID: ${option.edgeId}`,
      `   From node: ${option.sourceNodeId}`,
      `   To node after acceptance: ${option.targetNodeId}`,
      "   Kind: spawn",
      `   Spawn role: ${option.role}`,
      `   Category: ${option.category}`,
      `   Purpose: ${option.description}`,
      `   Result schema: ${option.outputSchemaId}`,
      `   Modes: ${option.allowedModes.join(", ")}`,
      "",
    );
  }

  lines.push(
    "Workflow API protocol:",
    "1. Use phenix_workflow with action=inspect to obtain the current nodeId and legal edgeIds.",
    "2. Use phenix_workflow with action=take, the same nodeId, one legal edgeId, and spawn input when the edge kind is spawn.",
    "The runtime revalidates the node and edge against fresh authority before changing state or spawning a child.",
    "Do not invent a role, result schema, model, thinking level, tool set, or delegation depth.",
  );
  return lines.join("\n");
}
