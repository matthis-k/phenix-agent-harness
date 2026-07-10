/**
 * helpers.ts — Pure helper functions for the state machine.
 *
 * Guards (isScout, isPlanner, etc.), effectId generator,
 * isWorkflowTask, tryParseJson, and isTerminal check.
 *
 * Extracted from machine.ts to reduce cognitive complexity.
 */

import type { EffectId, WorkflowState } from "./types";

// ── Agent role guards (prefix-based matching) ──

export function isScout(agent: string): boolean {
	return agent.includes("scout");
}

export function isPlanner(agent: string): boolean {
	return agent.includes("planner");
}

export function isVerifier(agent: string): boolean {
	return agent.includes("verifier");
}

export function isWorker(agent: string): boolean {
	return agent.includes("worker") || agent.includes("implementer");
}

// ── Effect ID generation ──

export function effectId(
	runId: string,
	stepIndex: number,
	phase: string,
	repairAttempt: number,
): EffectId {
	return `${runId}:${stepIndex}:${phase}:${repairAttempt}`;
}

// ── Terminal check ──

export function isTerminal(state: WorkflowState): boolean {
	return (
		state.tag === "done" || state.tag === "failed" || state.tag === "cancelled"
	);
}

// ── Prompt classification ──

export function isWorkflowTask(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (!trimmed) return false;
	if (trimmed.length < 25) return false;
	if (trimmed.endsWith("?") && trimmed.length < 80) return false;
	if (
		/^(yes|no|ok|okay|thanks|done|yep|nope|sure|got it|lol|aha)$/i.test(trimmed)
	)
		return false;
	return true;
}

// ── JSON parsing ──

export function tryParseJson(text: string): Record<string, unknown> | null {
	let cleaned = text.trim();
	const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)```$/);
	if (fenceMatch) cleaned = fenceMatch[1].trim();
	try {
		const parsed = JSON.parse(cleaned);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}
