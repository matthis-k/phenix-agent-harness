import type {
  WorkflowDefinition,
  WorkflowRuntimeRecord,
  DelegationAuthority,
  DelegationOption,
} from "./workflow-types.ts";
import { resolveDelegationOptions } from "./delegation-options.ts";
import type { HandleRecord } from "../phenix-subagents/handle-types.ts";
import type { Difficulty } from "../phenix-routing/types.ts";

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

// ── Workflow decision context (shared prompt + runtime) ─────────────────────

import { createHash } from "node:crypto";

/**
 * WorkflowDecisionContext is the single source of truth for what
 * transitions are legal at a given workflow state. Both the prompt
 * projector and the runtime delegate handler consume it to guarantee
 * equivalence.
 */
export interface WorkflowDecisionContext {
  readonly difficulty: Difficulty;
  readonly currentState: string;
  readonly revision: number;
  readonly options: readonly ModelDelegationOption[];
  /** Stable digest of the projected options. Verified at runtime. */
  readonly optionsDigest: string;
}

/**
 * Canonical options digest: SHA-256 of stable JSON of transitionIds + revisions.
 * Both prompt projection and runtime validation MUST compute the same digest.
 */
export function computeOptionsDigest(
  options: readonly ModelDelegationOption[],
): string {
  const canonical = options.map((o) => ({
    t: o.transitionId,
    r: o.workflowRevision,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Build the shared decision context from definition + runtime + authority.
 */
export function buildWorkflowDecisionContext(input: {
  readonly definition: WorkflowDefinition;
  readonly runtime: WorkflowRuntimeRecord;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly HandleRecord[];
}): WorkflowDecisionContext {
  const options = projectDelegationOptions(
    resolveDelegationOptions(input),
  );

  return {
    difficulty: input.runtime.difficulty,
    currentState: input.runtime.state,
    revision: input.runtime.revision,
    options,
    optionsDigest: computeOptionsDigest(options),
  };
}

// ── Build root workflow projection ──────────────────────────────────────────

export function buildRootWorkflowProjection(input: {
  readonly definition: WorkflowDefinition;
  readonly runtime: WorkflowRuntimeRecord;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly HandleRecord[];
}): ModelWorkflowProjection & { readonly optionsDigest: string } {
  const ctx = buildWorkflowDecisionContext(input);

  return {
    difficulty: ctx.difficulty,
    currentState: ctx.currentState,
    revision: ctx.revision,
    options: ctx.options,
    optionsDigest: ctx.optionsDigest,
  };
}

// ── Build child workflow projection ─────────────────────────────────────────

export function buildChildWorkflowProjection(input: {
  readonly definition: WorkflowDefinition;
  readonly runtime: WorkflowRuntimeRecord;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly HandleRecord[];
}): ModelWorkflowProjection & { readonly optionsDigest: string } {
  const ctx = buildWorkflowDecisionContext(input);

  return {
    difficulty: ctx.difficulty,
    currentState: ctx.currentState,
    revision: ctx.revision,
    options: ctx.options,
    optionsDigest: ctx.optionsDigest,
  };
}

// ── Format workflow projection as system prompt text ────────────────────────

export function formatWorkflowProjection(
  projection: ModelWorkflowProjection & { readonly optionsDigest?: string },
): string {
  const lines: string[] = [];

  lines.push("## Phenix workflow authority");
  lines.push("");
  lines.push(`Difficulty: ${projection.difficulty}`);
  lines.push(`Current state: ${projection.currentState}`);
  lines.push(`Workflow revision: ${projection.revision}`);
  if (projection.optionsDigest) {
    lines.push(`Options digest: ${projection.optionsDigest}`);
  }
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
  lines.push("- transitionId: one of the transition IDs listed above");
  lines.push("- workflowRevision: the workflow revision shown above");
  lines.push("- task: the bounded objective for the child");
  lines.push("- optional: requirements, tools narrowing, delegateRoles narrowing, mode");
  lines.push("");

  lines.push("Do not invent a role or transition.");

  return lines.join("\n");
}
