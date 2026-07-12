import type {
  WorkflowDefinition,
  WorkflowRuntimeRecord,
  DelegationAuthority,
  DelegationOption,
  WorkflowOutputSchemaId,
} from "./workflow-types.ts";
import { resolveDelegationOptions } from "./delegation-options.ts";
import type { HandleRecord } from "../phenix-subagents/handle-types.ts";
import type { Difficulty } from "../phenix-routing/types.ts";
import { getOutputSchema } from "./workflow-schemas.ts";

// ── Model-facing delegation option ──────────────────────────────────────────

export interface ModelDelegationOption {
  readonly transitionId: string;
  readonly workflowRevision: number;
  readonly role: string;
  readonly purpose: string;
  readonly description: string;
  readonly category: "required" | "optional" | "repair";
  readonly allowedModes: ReadonlyArray<"await" | "background">;
  readonly resultSchema: Record<string, unknown>;
}

// ── Model-facing workflow projection ────────────────────────────────────────

export interface ModelWorkflowProjection {
  readonly difficulty: string;
  readonly currentState: string;
  readonly revision: number;
  readonly options: readonly ModelDelegationOption[];
}

// ── Project delegation options ──────────────────────────────────────────────

export function projectDelegationOptions(
  options: readonly DelegationOption[],
): readonly ModelDelegationOption[] {
  return options.map((opt) => ({
    transitionId: opt.transitionId,
    workflowRevision: opt.workflowRevision,
    role: opt.role ?? "base",
    purpose: opt.purpose,
    description: opt.description,
    category: opt.category,
    allowedModes: opt.allowedModes,
    resultSchema: opt.outputSchema,
  }));
}

// ── Build root workflow projection ──────────────────────────────────────────

export function buildRootWorkflowProjection(input: {
  readonly definition: WorkflowDefinition;
  readonly runtime: WorkflowRuntimeRecord;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly HandleRecord[];
}): ModelWorkflowProjection {
  const options = resolveDelegationOptions(input);

  return {
    difficulty: input.runtime.difficulty,
    currentState: input.runtime.state,
    revision: input.runtime.revision,
    options: projectDelegationOptions(options),
  };
}

// ── Build child workflow projection ─────────────────────────────────────────

export function buildChildWorkflowProjection(input: {
  readonly definition: WorkflowDefinition;
  readonly runtime: WorkflowRuntimeRecord;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly HandleRecord[];
}): ModelWorkflowProjection {
  const options = resolveDelegationOptions(input);

  return {
    difficulty: input.runtime.difficulty,
    currentState: input.runtime.state,
    revision: input.runtime.revision,
    options: projectDelegationOptions(options),
  };
}

// ── Format workflow projection as system prompt text ────────────────────────

export function formatWorkflowProjection(
  projection: ModelWorkflowProjection,
): string {
  const lines: string[] = [];

  lines.push("## Phenix workflow authority");
  lines.push("");
  lines.push(`Difficulty: ${projection.difficulty}`);
  lines.push(`Current state: ${projection.currentState}`);
  lines.push(`Workflow revision: ${projection.revision}`);
  lines.push("");

  if (projection.options.length === 0) {
    lines.push(
      "No delegation transition is currently legal.",
    );
    lines.push(
      "Complete the current assignment using phenix_complete.",
    );
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    "You may currently delegate only through these transitions:",
  );
  lines.push("");

  for (let i = 0; i < projection.options.length; i++) {
    const opt = projection.options[i];
    lines.push(`${i + 1}. ${opt.transitionId}`);
    lines.push(`   Role: ${opt.role}`);
    lines.push(`   Category: ${opt.category}`);
    lines.push(`   Purpose: ${opt.description}`);
    lines.push(`   Modes: ${opt.allowedModes.join(", ")}`);
    lines.push("");
  }

  lines.push("Call phenix_delegate with exactly:");
  lines.push("- transitionId");
  lines.push("- workflowRevision");
  lines.push("- task");
  lines.push("- optional requirements");
  lines.push("- optional narrowing patches");
  lines.push("");

  lines.push("Do not invent a role or transition.");

  return lines.join("\n");
}
