/**
 * prompt-builder.ts — Shared prompt construction for workflow phases.
 *
 * Builds the system-prompt injection for each workflow phase, including
 * variable substitution ({outputs.<key>}, {previous}) and output-file
 * instructions.
 *
 * Single source of truth — imported by both machine.ts (reducer) and
 * index.ts (adapter), eliminating the old buildStepPrompt / buildInlineStepPrompt
 * duplication.
 */

export interface HandoffIdentity {
	runId: string;
	stepId: string;
	effectId: string;
	attempt: number;
}

import type { ChainStep } from "./types.js";

/**
 * Build the full prompt for a chain step, replacing tokens with
 * accumulated outputs from previous phases.
 *
 * @param step      The chain step definition
 * @param prompt    The original user/flow prompt
 * @param outputs   Accumulated phase outputs keyed by step `as` tag
 * @param identity  Optional handoff identity fields (runId, stepId, effectId, attempt)
 */
export function buildStepPrompt(
	step: ChainStep,
	prompt: string,
	outputs: Record<string, string>,
	identity?: HandoffIdentity,
): string {
	let instruction = step.instruction;

	// Replace {outputs.<key>} with actual output content
	instruction = instruction.replace(/\{outputs\.(\w+)\}/g, (_match, key) => {
		if (outputs[key]) return outputs[key];
		return `(output from ${key} phase)`;
	});

	// Replace {previous} with prompt
	instruction = instruction.replace(/\{previous\}/g, prompt);

	const parts: string[] = [
		"## Phenix Workflow Phase",
		"",
		`Task: ${prompt}`,
		"",
		`### Phase: ${step.label} (${step.agent})`,
		"",
		instruction,
		"",
	];

	if (step.output) {
		parts.push(
			`Write your output to \`${step.output}\`. This will be consumed by the next phase.`,
		);
		parts.push("");
	}

	// Include handoff identity so the subagent knows what values to use
	if (identity) {
		parts.push("## Handoff identity");
		parts.push("");
		parts.push(
			"When you complete this phase, call `phenix_handoff` with these exact identity values:",
		);
		parts.push("");
		parts.push(`- \`runId\`: \`${identity.runId}\``);
		parts.push(`- \`stepId\`: \`${identity.stepId}\``);
		parts.push(`- \`effectId\`: \`${identity.effectId}\``);
		parts.push(`- \`attempt\`: ${identity.attempt}`);
		parts.push("");
		parts.push("Do **not** invent these values. Use the exact values above.");
		parts.push("");
	}

	parts.push("---");
	return parts.join("\n");
}
