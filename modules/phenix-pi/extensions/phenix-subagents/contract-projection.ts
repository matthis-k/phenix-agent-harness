import type { ContractArtifactV2 } from "./contract.ts";
import type { JsonSchema } from "./contracts.ts";
import type { AgentRole } from "./policy.ts";

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
}

// ── Projection formatter ────────────────────────────────────────────────────

/**
 * Derive the safe model-facing projection from a contract artifact.
 */
export function deriveProjection(
  contract: ContractArtifactV2,
): ModelContractProjection {
  return {
    role: contract.identity.role,
    task: contract.assignment.task,
    requirements: contract.assignment.requirements,
    tools: contract.runtime.tools.effective,
    allowedChildren: contract.runtime.allowedChildren
      .filter((r): r is AgentRole => r !== null)
      .map((r) => r as string),
    outputSchema: contract.assignment.outputSchema,
    completionTool: "phenix_complete",
  };
}

/**
 * Format the model-facing projection as a system-prompt section.
 * Contains only safe task-facing information.
 */
export function formatProjection(
  projection: ModelContractProjection,
): string {
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

  // Allowed child roles
  if (projection.allowedChildren.length > 0) {
    lines.push("Allowed child roles:");
    for (const role of projection.allowedChildren) {
      lines.push(`- ${role}`);
    }
    lines.push("");
  }

  // Required result schema
  lines.push("Required result schema:");
  lines.push(JSON.stringify(projection.outputSchema, null, 2));
  lines.push("");

  // Completion instruction
  lines.push(
    "Complete the assignment by calling:",
  );
  lines.push(
    "phenix_complete({ value: <schema-conforming value> })",
  );
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
  contract: ContractArtifactV2,
): string {
  return formatProjection(deriveProjection(contract));
}
