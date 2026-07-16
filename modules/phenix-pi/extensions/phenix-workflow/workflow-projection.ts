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
  const options = projectDelegationOptions(input.runtime.state, resolveDelegationOptions(input));
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

/** Format the authority snapshot that is deterministically injected before inference. */
export function formatWorkflowProjection(projection: ModelWorkflowProjection): string {
  const lines = [
    "## Phenix workflow authority",
    "",
    "This authority snapshot was resolved by the runtime before this agent started.",
    "The active session or contract owns the current node; never send a node ID back to the runtime.",
    `Current node: ${projection.currentState}`,
    `Difficulty: ${projection.difficulty}`,
    "",
  ];

  if (projection.options.length === 0) {
    lines.push(
      "The current contract-bound node has no legal outgoing spawn edge.",
      "Complete the current assignment directly using phenix_complete.",
      "",
    );
    return lines.join("\n");
  }

  lines.push(
    "Legal workflow edges available to this agent:",
    "Use these when delegation would materially improve evidence, planning, implementation, testing, or review.",
    "",
  );
  for (const [index, option] of projection.options.entries()) {
    lines.push(
      `${index + 1}. Edge ID: ${option.edgeId}`,
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
    "Workflow invocation protocol:",
    "- Call phenix_workflow with one advertised edgeId and its spawn input.",
    "- The runtime derives the current node from the active session or contract and verifies that the edge is still legal.",
    "- Do not invent a role, result schema, model, thinking level, tool set, delegation depth, or node ID.",
  );
  return lines.join("\n");
}
