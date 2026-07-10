/**
 * handlers/direct.ts — D0 direct state transitions.
 *
 * D0 has a single worker step, no scout/planner/verifier.
 * Extracted from machine.ts to reduce cognitive complexity per file.
 */

import type {
	DirectState,
	PhaseCompletedEvent,
	ReduceResult,
	WorkflowEvent,
	WorkflowEffect,
} from "../types";
import { buildStepPrompt } from "../prompt-builder";
import { effectId } from "../helpers";

export function reduceDirect(
	state: DirectState,
	event: WorkflowEvent,
): ReduceResult {
	switch (event.type) {
		case "PHASE_COMPLETED":
			return onDirectPhaseCompleted(state, event);
		case "CANCELLED":
			return {
				state: { tag: "cancelled", runId: state.runId },
				effects: [
					{
						type: "NOTIFY",
						message: "⏹️ Workflow cancelled.",
						level: "warning",
					},
				],
			};
		case "START_WORKFLOW":
			return { state, effects: [] };
		default:
			return { state, effects: [] };
	}
}

function onDirectPhaseCompleted(
	state: DirectState,
	_event: PhaseCompletedEvent,
): ReduceResult {
	const { chainSteps, chainIndex, runId, originalModelRef } = state;

	if (chainIndex >= chainSteps.length - 1) {
		return {
			state: { tag: "done", runId, difficulty: "D0" },
			effects: originalModelRef
				? [{ type: "RESTORE_MODEL", modelRef: originalModelRef }]
				: [{ type: "NOOP" as const }],
		};
	}

	const nextState: DirectState = { ...state, chainIndex: chainIndex + 1 };
	return dispatchFrom(state, nextState);
}

/** Build a RUN_PHASE effect for the next step in a direct state. */
function dispatchFrom(_current: DirectState, next: DirectState): ReduceResult {
	const step = next.chainSteps[next.chainIndex];
	if (!step) {
		return {
			state: { tag: "done", runId: next.runId, difficulty: "D0" },
			effects: [],
		};
	}

	const id = effectId(next.runId, next.chainIndex, step.phase, 0);
	const fullPrompt = buildStepPrompt(step, next.prompt, {});
	const effects: WorkflowEffect[] = [
		{ type: "RUN_PHASE", effectId: id, step, fullPrompt },
	];

	return { state: next, effects };
}
