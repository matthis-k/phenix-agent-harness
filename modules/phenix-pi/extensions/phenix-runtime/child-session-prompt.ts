/**
 * child-session-prompt — deterministic child system prompt composition
 *
 * Replaces temporary runtime agent materialization (contract-agent-materializer).
 * No YAML/frontmatter files are generated. Personas are ordinary Phenix
 * resources. One deterministic child prompt is composed from:
 * 1. persona
 * 2. exact assignment
 * 3. requirements
 * 4. output schema projection
 * 5. effective tool/delegation boundaries
 * 6. legal delegation options
 * 7. completion protocol
 * 8. relevant workflow state
 */

import type { AgentRole } from "../phenix-kernel/agents.ts";
import type { ContractArtifact } from "../phenix-subagents/contract.ts";
import type {
  ModelWorkflowProjection,
} from "../phenix-workflow/workflow-projection.ts";
import { formatWorkflowProjection } from "../phenix-workflow/workflow-projection.ts";
import { formatProjection } from "../phenix-subagents/contract-projection.ts";
import { deriveProjection } from "../phenix-subagents/contract-projection.ts";

// ── Persona definition ──────────────────────────────────────────────────────

export interface PersonaDefinition {
  readonly role: AgentRole | null;
  readonly body: string;
}

// ── Child workflow projection ───────────────────────────────────────────────

export interface ChildWorkflowProjection extends ModelWorkflowProjection {}

// ── System prompt builder ───────────────────────────────────────────────────

/**
 * Compose one deterministic child system prompt.
 *
 * Contains:
 * 1. persona
 * 2. exact assignment
 * 3. requirements
 * 4. output schema projection
 * 5. effective tool/delegation boundaries
 * 6. legal delegation options
 * 7. completion protocol
 * 8. relevant workflow state
 *
 * Does NOT include capability secrets, store paths, capability tokens,
 * or implementation-specific session metadata.
 */
export function buildChildSystemPrompt(input: {
  readonly persona: PersonaDefinition;
  readonly contract: ContractArtifact;
  readonly workflowProjection: ChildWorkflowProjection;
}): string {
  const { persona, contract, workflowProjection } = input;

  const sections: string[] = [];

  // 1. Persona
  if (persona.body) {
    sections.push(persona.body);
  }

  // 2-4, 7. Assignment, requirements, output schema, completion protocol
  const projection = deriveProjection(contract, workflowProjection);
  sections.push(formatProjection(projection));

  // 5-6, 8. Effective tool/delegation boundaries, legal delegation options, workflow state
  if (workflowProjection.options.length > 0) {
    sections.push(formatWorkflowProjection(workflowProjection));
  }

  // Effective tool boundaries
  const effectiveTools = contract.runtime.tools.effective;
  if (effectiveTools.length > 0) {
    sections.push(
      [
        "## Effective tool boundaries",
        "",
        "Only the following tools are available in this session:",
        ...effectiveTools.map((t) => `- ${t}`),
        "",
        "The phenix_complete tool is always available for submitting your result.",
        "The phenix_delegate tool is available only when delegation is legal and listed above.",
      ].join("\n"),
    );
  }

  // Delegation boundary
  const canDelegate =
    contract.runtime.delegation.remainingDepth > 0 &&
    contract.runtime.delegation.availableRoles.length > 0;

  if (!canDelegate) {
    sections.push(
      [
        "## Delegation boundary",
        "",
        "No further delegation is permitted in this session. " +
        "Complete the assignment directly using phenix_complete.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
