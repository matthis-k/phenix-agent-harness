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

import type { ChainStep } from "./types";

/**
 * Build the full prompt for a chain step, replacing tokens with
 * accumulated outputs from previous phases.
 *
 * @param step      The chain step definition
 * @param prompt    The original user/flow prompt
 * @param outputs   Accumulated phase outputs keyed by step `as` tag
 */
export function buildStepPrompt(
	step: ChainStep,
	prompt: string,
	outputs: Record<string, string>,
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

	parts.push("---");
	return parts.join("\n");
}
