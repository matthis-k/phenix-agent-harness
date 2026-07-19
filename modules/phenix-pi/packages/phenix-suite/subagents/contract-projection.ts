import type { JsonSchema } from "@matthis-k/phenix-contracts/definitions.ts";
import type { ModelWorkflowProjection } from "@matthis-k/phenix-flow/workflow-projection.ts";
import type { AgentRole } from "./agent-types.ts";
import type { ContractArtifact } from "./contract.ts";

// ── Model-facing projection ─────────────────────────────────────────────────

/**
 * The safe projection of a contract that the model may see.
 * Contains no runtime secrets, contract-store paths, token hashes,
 * or other internal metadata.
 */
export interface ModelContractProjection {
  readonly role: AgentRole;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly tools: readonly string[];
  readonly allowedChildren: readonly string[];
  readonly outputSchema: JsonSchema;
  readonly completionTool: "phenix_complete";
  readonly workflow: ModelWorkflowProjection;
}

// ── Projection formatter ────────────────────────────────────────────────────

/**
 * Derive the safe model-facing projection from a contract artifact.
 */
export function deriveProjection(
  contract: ContractArtifact,
  workflowProjection: ModelWorkflowProjection,
): ModelContractProjection {
  return {
    role: contract.identity.role,
    task: contract.assignment.task,
    requirements: contract.assignment.requirements,
    tools: contract.runtime.tools.effective,
    allowedChildren: contract.runtime.delegation.roles.effective
      .filter((r): r is AgentRole => r !== null)
      .map((r) => r as string),
    outputSchema: contract.assignment.outputSchema,
    completionTool: "phenix_complete",
    workflow: workflowProjection,
  };
}

/**
 * Format the model-facing projection as a system-prompt section.
 * Contains only safe task-facing information.
 */
export function formatProjection(projection: ModelContractProjection): string {
  const lines: string[] = [];

  lines.push("## Phenix child assignment");
  lines.push("");

  // Role
  const roleDisplay = projection.role === null ? "none (base)" : projection.role;
  lines.push(`Role: ${roleDisplay}`);
  lines.push("");

  // Task
  lines.push("Task:");
  lines.push(projection.task);
  lines.push("");

  // Requirements
  if (projection.requirements.length > 0) {
    lines.push("Requirements:");
    for (let i = 0; i < projection.requirements.length; i++) {
      lines.push(`${i + 1}. ${projection.requirements[i]}`);
    }
    lines.push("");
  }

  // Authorized task tools
  if (projection.tools.length > 0) {
    lines.push("Authorized task tools:");
    for (const tool of projection.tools) {
      lines.push(`- ${tool}`);
    }
    lines.push("");
  }

  // Workflow projection
  if (projection.workflow && projection.workflow.options.length > 0) {
    lines.push("## Phenix workflow authority");
    lines.push("");
    lines.push(`Current state: ${projection.workflow.currentState}`);
    lines.push(`Workflow revision: ${projection.workflow.revision}`);
    lines.push("");
    lines.push("Available delegation transitions:");
    for (const opt of projection.workflow.options) {
      lines.push(`- ${opt.transitionId} → ${opt.role} (${opt.category})`);
    }
    lines.push("");
  }

  // Required result schema
  lines.push("Required result schema:");
  lines.push(JSON.stringify(projection.outputSchema, null, 2));
  lines.push("");

  // Completion instruction
  lines.push("Complete the assignment by calling:");
  lines.push("phenix_complete({ value: <schema-conforming value> })");
  lines.push("");
  lines.push(
    "The value will be validated against the output schema. If validation fails, correct the reported fields and call phenix_complete again.",
  );

  return lines.join("\n");
}

/**
 * Build the full formatted projection from a contract artifact.
 * Convenience: deriveProjection + formatProjection.
 */
export function buildContractProjection(
  contract: ContractArtifact,
  workflowProjection: ModelWorkflowProjection,
): string {
  return formatProjection(deriveProjection(contract, workflowProjection));
}
