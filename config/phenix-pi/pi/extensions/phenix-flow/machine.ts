/**
 * phenix-flow/machine.ts — Pure statechart reducer.
 *
 * The reducer is the ONLY thing allowed to transition state.
 * It takes (state, event) → (newState, effects[]) deterministically.
 *
 * Invariants enforced:
 * - D0 stays in direct branch (no scout/plan/verify states reachable)
 * - D1-D3 use awaiting-handoff state between subagent phases
 * - Only trusted HANDOFF_ACCEPTED events advance the workflow
 * - Terminal states (done/failed/cancelled) absorb all events
 * - Repair loop has bounded attempts
 */

import type {
	WorkflowState,
	WorkflowEvent,
	WorkflowEffect,
	DirectState,
	DelegatedState,
	AwaitingHandoffState,
	IdleState,
	ReduceResult,
	PhaseCompletedEvent,
	VerifyResultEvent,
	Difficulty,
	ChainStep,
	HandoffAcceptedEvent,
	HandoffRejectedEvent,
} from "./types.js";
import { buildStepPrompt, type HandoffIdentity } from "./prompt-builder.js";
import {
	isScout,
	isPlanner,
	isVerifier,
	isWorker,
	effectId,
	isTerminal,
	tryParseJson,
} from "./helpers.js";
import { reduceDirect } from "./handlers/direct.js";
import { ROLE_TO_HANDOFF_KIND, type PhaseRole } from "./handoff/schemas.js";

// ── Defaults ──
const MAX_REPAIR_ATTEMPTS = 3;

// ═══════════════════════════════════════════════
// REDUCER
// ═══════════════════════════════════════════════

/**
 * Pure reducer: given the current state and an event, return the next state
 * and effects to execute.
 *
 * The reducer owns all transition logic. No mutations, no side effects.
 */
export function reduce(
	state: WorkflowState,
	event: WorkflowEvent,
): ReduceResult {
	// Terminal states absorb all events
	if (isTerminal(state)) {
		return { state, effects: [] };
	}

	switch (state.tag) {
		case "idle":
			return reduceIdle(state, event);
		case "direct":
			return reduceDirect(state, event);
		case "delegated":
			return reduceDelegated(state, event);
		case "awaiting-handoff":
			return reduceAwaitingHandoff(state, event);
		default:
			return { state, effects: [] };
	}
}

// ── Idle state transitions ──

function reduceIdle(state: IdleState, event: WorkflowEvent): ReduceResult {
	if (event.type !== "START_WORKFLOW") {
		return { state, effects: [] };
	}

	const { runId, sessionId, prompt, difficulty, chainSteps, originalModelRef } =
		event;

	if (chainSteps.length === 0) {
		return {
			state: {
				tag: "failed",
				runId,
				difficulty,
				reason: "Empty chain: no steps",
			},
			effects: [
				{
					type: "NOTIFY",
					message: "Empty chain — no steps defined.",
					level: "error",
				},
			],
		};
	}

	if (difficulty === "D0") {
		const directState: DirectState = {
			tag: "direct",
			runId,
			sessionId,
			prompt,
			difficulty: "D0",
			chainSteps,
			chainIndex: 0,
			originalModelRef,
		};
		return dispatchCurrentStep(directState, 0);
	}

	const delegatedState: DelegatedState = {
		tag: "delegated",
		runId,
		sessionId,
		prompt,
		difficulty: difficulty as "D1" | "D2" | "D3",
		chainSteps,
		chainIndex: 0,
		repairAttempts: 0,
		maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
		originalModelRef,
		outputs: {},
	};
	return dispatchCurrentStep(delegatedState, 0);
}

// ── Delegated state transitions (D1-D3 before handoff) ──

function reduceDelegated(
	state: DelegatedState,
	event: WorkflowEvent,
): ReduceResult {
	switch (event.type) {
		case "HANDOFF_ACCEPTED":
			return onHandoffAccepted(state, event);
		case "HANDOFF_REJECTED":
			return onHandoffRejected(state, event);
		case "PHASE_COMPLETED":
			return onDelegatedPhaseCompleted(state, event);
		case "VERIFY_RESULT":
			return processVerifierOutput(state, event);
		case "PHASE_CONTRACT_VIOLATION":
			return failState(state.runId, state.difficulty, event.reason);
		case "CANCELLED":
			return cancelState(state);
		case "START_WORKFLOW":
			return { state, effects: [] };
		default:
			return { state, effects: [] };
	}
}

// ── Awaiting-handoff state transitions ──

function reduceAwaitingHandoff(
	state: AwaitingHandoffState,
	event: WorkflowEvent,
): ReduceResult {
	switch (event.type) {
		case "HANDOFF_ACCEPTED":
			return onHandoffAccepted(state, event);
		case "HANDOFF_REJECTED":
			return onHandoffRejected(state, event);
		case "PHASE_COMPLETED":
			// Agent exited without calling the handoff tool
			return {
				state: {
					tag: "failed",
					runId: state.runId,
					difficulty: state.difficulty,
					reason: `Agent for phase "${state.chainSteps[state.chainIndex]?.label ?? "?"}" exited without handoff`,
				},
				effects: [
					{
						type: "NOTIFY",
						message:
							"🚫 Phase exited without handoff — expected `phenix_handoff` tool call.",
						level: "error",
					},
				],
			};
		case "CANCELLED":
			return cancelState(state);
		case "START_WORKFLOW":
			return { state, effects: [] };
		default:
			return { state, effects: [] };
	}
}

// ── Handoff event handlers ──

/** Helper: produce a done result with a RESTORE_MODEL and a NOTIFY effect. */
function doneResult(
	runId: string,
	difficulty: Difficulty,
	originalModelRef: string | null | undefined,
	message: string,
): ReduceResult {
	return {
		state: { tag: "done", runId, difficulty },
		effects: [
			{ type: "RESTORE_MODEL", modelRef: originalModelRef ?? "" },
			{ type: "NOTIFY", message, level: "info" },
		],
	};
}

/** Handle scout-specific handoff results (already-satisfied or D0 recommendation). */
function handleScoutHandoff(
	step: ChainStep,
	parsed: Record<string, unknown> | null,
	state: DelegatedState | AwaitingHandoffState,
): ReduceResult | null {
	if (!isScout(step.agent) || !parsed) return null;

	if (parsed.taskAlreadySatisfied === true) {
		return doneResult(
			state.runId,
			state.difficulty,
			state.originalModelRef,
			"✅ Scout determined task is already satisfied.",
		);
	}

	if (parsed.recommendedDifficulty === "D0") {
		const workerStep = state.chainSteps.find((s) => isWorker(s.agent));
		if (workerStep) {
			const directState: DirectState = {
				tag: "direct",
				runId: state.runId,
				sessionId: "sessionId" in state ? state.sessionId : "",
				prompt: state.prompt,
				difficulty: "D0",
				chainSteps: [workerStep],
				chainIndex: 0,
				originalModelRef: state.originalModelRef,
			};
			return dispatchCurrentStep(directState, 0);
		}
	}

	return null;
}

function onHandoffAccepted(
	state: DelegatedState | AwaitingHandoffState,
	event: HandoffAcceptedEvent,
): ReduceResult {
	const {
		runId,
		prompt,
		difficulty,
		chainSteps,
		chainIndex,
		outputs,
		originalModelRef,
	} = state;

	const step = chainSteps[chainIndex];
	if (!step) {
		return doneResult(
			runId,
			difficulty,
			originalModelRef,
			"✅ Workflow completed.",
		);
	}

	// Handle scout-specific results
	const parsed = tryParseJson(event.phaseOutput);
	const scoutResult = handleScoutHandoff(step, parsed, state);
	if (scoutResult) return scoutResult;

	// Capture output for next phases
	const outputKey = step.as || step.agent;
	const newOutputs: Record<string, string> = {
		...outputs,
		[outputKey]: event.phaseOutput,
	};

	// Advance to next step
	const nextIndex = chainIndex + 1;

	// All steps complete → done
	if (nextIndex >= chainSteps.length) {
		return doneResult(
			runId,
			difficulty,
			originalModelRef,
			"✅ Workflow completed successfully.",
		);
	}

	const repairAttempts = "repairAttempts" in state ? state.repairAttempts : 0;

	const nextState: DelegatedState = {
		tag: "delegated",
		runId,
		sessionId: "sessionId" in state ? state.sessionId : "",
		prompt,
		difficulty: difficulty as "D1" | "D2" | "D3",
		chainSteps,
		chainIndex: nextIndex,
		repairAttempts,
		maxRepairAttempts:
			"maxRepairAttempts" in state
				? state.maxRepairAttempts
				: MAX_REPAIR_ATTEMPTS,
		originalModelRef,
		outputs: newOutputs,
	};
	return dispatchCurrentStep(nextState, nextIndex);
}

function onHandoffRejected(
	state: DelegatedState | AwaitingHandoffState,
	event: HandoffRejectedEvent,
): ReduceResult {
	const rejection = event.error;

	// Schema-invalid rejections are non-fatal — the agent can resubmit
	if (
		rejection.kind === "schema-invalid" ||
		rejection.kind === "unknown-keys"
	) {
		// Stay in the same state; the tool already returned an error to the agent
		return {
			state,
			effects: [
				{
					type: "NOTIFY",
					message: `⚠️ Handoff rejected (resubmit): ${rejection.kind}`,
					level: "warning",
				},
			],
		};
	}

	// File-claim mismatches — also resubmittable
	if (rejection.kind === "changed-file-mismatch") {
		return {
			state,
			effects: [
				{
					type: "NOTIFY",
					message: `⚠️ Handoff rejected — file claim mismatch (resubmit)`,
					level: "warning",
				},
			],
		};
	}

	// Verification failures — non-fatal (resubmit or repair)
	if (
		rejection.kind === "verification-incomplete" ||
		rejection.kind === "verification-stale"
	) {
		return {
			state,
			effects: [
				{
					type: "NOTIFY",
					message: `⚠️ Verification handoff rejected — ${rejection.kind}`,
					level: "warning",
				},
			],
		};
	}

	// Missing-required-handoff is always fatal
	if (rejection.kind === "missing-required-handoff") {
		const runId = "runId" in state ? state.runId : "unknown";
		const difficulty = "difficulty" in state ? state.difficulty : "D1";
		return {
			state: {
				tag: "failed",
				runId,
				difficulty,
				reason: "Missing required handoff",
			},
			effects: [
				{
					type: "NOTIFY",
					message: "🚫 Phase exited without required handoff.",
					level: "error",
				},
			],
		};
	}

	// Stale correlation — potentially fatal (agent is out of sync)
	const runId = "runId" in state ? state.runId : "unknown";
	const difficulty = "difficulty" in state ? state.difficulty : "D1";

	// Stale-run/stale-step/stale-effect/stale-attempt are fatal — agent state is corrupted
	return {
		state: {
			tag: "failed",
			runId,
			difficulty,
			reason: `Handoff rejection: ${rejection.kind}`,
		},
		effects: [
			{
				type: "NOTIFY",
				message: `🚫 Fatal handoff error: ${rejection.kind}`,
				level: "error",
			},
		],
	};
}

// ── Legacy phase completion (fallback when no handoff tool was used) ──

function onDelegatedPhaseCompleted(
	state: DelegatedState,
	event: PhaseCompletedEvent,
): ReduceResult {
	const { runId, difficulty, originalModelRef } = state;

	if (isVerifier(event.stepAgent)) {
		return processVerifierOutput(state, event);
	}

	// If handoff system is active (awaiting-handoff), this event should not arrive
	// But as a safety net, produce a missing-required-handoff error
	return {
		state: {
			tag: "failed",
			runId,
			difficulty,
			reason: `Agent for "${event.stepAgent}" completed without handoff tool call`,
		},
		effects: [
			{
				type: "RESTORE_MODEL",
				modelRef: originalModelRef ?? "",
			},
			{
				type: "NOTIFY",
				message:
					"🚫 Phase completed without `phenix_handoff` tool — workflow cannot advance.",
				level: "error",
			},
		],
	};
}

/**
 * Process a verifier output: parse it and decide pass/fail.
 * This can be called from PHASE_COMPLETED or VERIFY_RESULT events.
 */
function processVerifierOutput(
	state: DelegatedState,
	event: PhaseCompletedEvent | VerifyResultEvent,
): ReduceResult {
	const { runId, difficulty } = state;

	if (event.type === "VERIFY_RESULT") {
		return handleVerdict(state, event.passed, event.reason);
	}

	const parsed = tryParseJson(event.output);
	if (!parsed || typeof parsed.status !== "string") {
		return failState(
			runId,
			difficulty,
			"Verifier output missing 'status' field",
		);
	}

	return handleVerdict(state, parsed.status === "pass", undefined);
}

/** Build the repair state and effects when verification fails. */
function buildRepairEffects(
	state: DelegatedState,
	attemptsLeft: number,
	reason: string | undefined,
): ReduceResult {
	const {
		runId,
		difficulty,
		chainSteps,
		repairAttempts,
		maxRepairAttempts,
		originalModelRef,
	} = state;

	if (attemptsLeft <= 0) {
		return {
			state: {
				tag: "failed",
				runId,
				difficulty,
				reason:
					reason ??
					`Verification failed after ${repairAttempts + 1} attempt(s)`,
			},
			effects: [
				{ type: "RESTORE_MODEL", modelRef: originalModelRef ?? "" },
				{
					type: "NOTIFY",
					message: "🚫 Verification failed — no repair attempts remaining.",
					level: "error",
				},
			],
		};
	}

	const resetIndex = Math.max(
		0,
		chainSteps.findIndex((s) => isPlanner(s.agent) || isWorker(s.agent)),
	);

	const repairState: DelegatedState = {
		...state,
		chainIndex: resetIndex,
		repairAttempts: repairAttempts + 1,
	};

	const repairStep = repairState.chainSteps[resetIndex];
	const repairEffectId = repairStep
		? effectId(
				repairState.runId,
				resetIndex,
				repairStep.phase,
				repairAttempts + 1,
			)
		: null;

	const effects: WorkflowEffect[] = [
		{
			type: "NOTIFY",
			message: `🔄 Verification failed — repair attempt ${repairAttempts + 1}/${maxRepairAttempts}.`,
			level: "warning",
		},
	];

	if (repairStep && repairEffectId) {
		const identity: HandoffIdentity = {
			runId: repairState.runId,
			stepId: repairStep.label || repairStep.agent,
			effectId: repairEffectId,
			attempt: repairAttempts + 1,
		};
		const fullPrompt = buildStepPrompt(
			repairStep,
			repairState.prompt,
			repairState.outputs,
			identity,
		);
		effects.push({
			type: "RUN_PHASE",
			effectId: repairEffectId,
			step: repairStep,
			fullPrompt,
		});
	}

	return { state: repairState, effects };
}

function handleVerdict(
	state: DelegatedState,
	passed: boolean,
	reason?: string,
): ReduceResult {
	const { runId, difficulty, originalModelRef } = state;

	if (passed) {
		return doneResult(
			runId,
			difficulty,
			originalModelRef,
			"✅ Verification passed.",
		);
	}

	const attemptsLeft = state.maxRepairAttempts - (state.repairAttempts + 1);
	return buildRepairEffects(state, attemptsLeft, reason);
}

// ── Phase dispatch helper ──

/**
 * Build the effect to run the current step.
 * For D1-D3, transitions to awaiting-handoff state immediately so the reducer
 * knows what handoff to expect.
 */
function dispatchCurrentStep(
	state: DirectState | DelegatedState,
	stepIndex: number,
): ReduceResult {
	const step = state.chainSteps[stepIndex];
	if (!step) {
		return {
			state: { tag: "done", runId: state.runId, difficulty: state.difficulty },
			effects: [],
		};
	}

	const id = effectId(
		state.runId,
		stepIndex,
		step.phase,
		state.tag === "delegated" ? state.repairAttempts : 0,
	);

	const outputs =
		state.tag === "delegated" ? (state as DelegatedState).outputs : {};
	const prompt = state.prompt;
	const attempt = state.tag === "delegated" ? state.repairAttempts + 1 : 1;
	const identity: HandoffIdentity = {
		runId: state.runId,
		stepId: step.label || step.agent,
		effectId: id,
		attempt,
	};
	const fullPrompt = buildStepPrompt(step, prompt, outputs, identity);

	// For D0, stay in direct state
	if (state.tag === "direct") {
		return {
			state,
			effects: [{ type: "RUN_PHASE", effectId: id, step, fullPrompt }],
		};
	}

	// For D1-D3, transition to awaiting-handoff with expected correlation
	const role = inferRole(step.agent);
	const artifactKind = role ? ROLE_TO_HANDOFF_KIND[role] : undefined;

	const awaitingState: AwaitingHandoffState = {
		tag: "awaiting-handoff",
		runId: state.runId,
		sessionId: state.sessionId,
		prompt,
		difficulty: state.difficulty,
		chainSteps: state.chainSteps,
		chainIndex: stepIndex,
		repairAttempts: state.tag === "delegated" ? state.repairAttempts : 0,
		maxRepairAttempts:
			state.tag === "delegated"
				? (state as DelegatedState).maxRepairAttempts
				: MAX_REPAIR_ATTEMPTS,
		originalModelRef: state.originalModelRef,
		outputs,
		expected: {
			role: role ?? "worker",
			artifactKind: artifactKind ?? "worker-result",
			stepId: identity.stepId,
			effectId: id,
			attempt,
		},
	};

	return {
		state: awaitingState,
		effects: [{ type: "RUN_PHASE", effectId: id, step, fullPrompt }],
	};
}

// ── Helpers ──

/**
 * Infer the PhaseRole from an agent name.
 */
function inferRole(agentName: string): PhaseRole | null {
	const lower = agentName.toLowerCase();
	if (lower.includes("scout")) return "scout";
	if (lower.includes("planner")) return "planner";
	if (lower.includes("worker") || lower.includes("implementer"))
		return "worker";
	if (lower.includes("verifier")) return "verifier";
	if (lower.includes("repair") || lower.includes("debugger")) return "repair";
	return null;
}

function cancelState(state: {
	runId: string;
	originalModelRef?: string | null;
}): ReduceResult {
	return {
		state: { tag: "cancelled", runId: state.runId },
		effects: [
			{ type: "RESTORE_MODEL", modelRef: state.originalModelRef ?? "" },
			{ type: "NOTIFY", message: "⏹️ Workflow cancelled.", level: "warning" },
		],
	};
}

function failState(
	runId: string,
	difficulty: Difficulty,
	reason: string,
): ReduceResult {
	return {
		state: { tag: "failed", runId, difficulty, reason },
		effects: [{ type: "NOTIFY", message: `🚫 ${reason}`, level: "error" }],
	};
}
