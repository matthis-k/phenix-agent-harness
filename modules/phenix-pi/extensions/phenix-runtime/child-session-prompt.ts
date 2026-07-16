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
 * 6. pre-resolved legal target agents
 * 7. completion protocol
 * 8. relevant workflow state
 */

import type { AgentRole } from "../phenix-kernel/agents.ts";
import type { ContractArtifact } from "../phenix-subagents/contract.ts";
import { deriveProjection, formatProjection } from "../phenix-subagents/contract-projection.ts";
import type { ModelWorkflowProjection } from "../phenix-workflow/workflow-projection.ts";
import { formatWorkflowProjection } from "../phenix-workflow/workflow-projection.ts";

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
 * The workflow projection is resolved from the child contract before the model
 * starts. It is therefore the mandatory initial authority inspection; the model
 * never has to request or echo its current node.
 */
export function buildChildSystemPrompt(input: {
  readonly persona: PersonaDefinition;
  readonly contract: ContractArtifact;
  readonly workflowProjection: ChildWorkflowProjection;
}): string {
  const { persona, contract, workflowProjection } = input;

  const sections: string[] = [];

  if (persona.body) {
    sections.push(persona.body);
  }

  const projection = deriveProjection(contract, workflowProjection);
  sections.push(formatProjection(projection));
  sections.push(formatWorkflowProjection(workflowProjection));

  const effectiveTools = contract.runtime.tools.effective;
  if (effectiveTools.length > 0) {
    sections.push(
      [
        "## Effective tool boundaries",
        "",
        "Only the following task tools are available in this session:",
        ...effectiveTools.map((tool) => `- ${tool}`),
        "",
        "The phenix_complete tool is always available for submitting your result.",
        "The phenix_workflow tool is always available for spawning one advertised target agent from the preloaded authority snapshot.",
      ].join("\n"),
    );
  }

  const canDelegate =
    contract.runtime.delegation.remainingDepth > 0 &&
    contract.runtime.delegation.availableRoles.length > 0;

  if (!canDelegate) {
    sections.push(
      [
        "## Delegation boundary",
        "",
        "The initialized contract permits no further subagent creation. Complete the assignment directly using phenix_complete.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
