/**
 * phenix-flow/machine.ts — Pure statechart reducer.
 *
 * The reducer is the ONLY thing allowed to transition state.
 * It takes (state, event) → (newState, effects[]) deterministically.
 *
 * Invariants enforced:
 * - D0 stays in direct branch (no scout/plan/verify states reachable)
 * - D1-D3 stay in delegated branch
 * - Terminal states (done/failed/cancelled) absorb all events
 * - Repair loop has bounded attempts
 * - Handoff validates JSON validity only (no Zod schemas)
 * - Phase outputs recorded as MCP artifacts for durability
 */

import type {
	WorkflowState,
	WorkflowEvent,
	WorkflowEffect,
	DirectState,
	DelegatedState,
	IdleState,
	PhaseCompletedEvent,
	VerifyResultEvent,
	ChainStep,
	EffectId,
} from "./types";

// ── Defaults ──
const MAX_REPAIR_ATTEMPTS = 3;

// ═══════════════════════════════════════════════
// GUARDS
// ═══════════════════════════════════════════════

/** Check if the agent name indicates a scout. */
function isScout(agent: string): boolean {
	return agent.includes("scout");
}

/** Check if the agent name indicates a planner. */
function isPlanner(agent: string): boolean {
	return agent.includes("planner");
}

/** Check if the agent name indicates a verifier. */
function isVerifier(agent: string): boolean {
	return agent.includes("verifier");
}

/** Check if the agent name indicates a worker/implementer. */
function isWorker(agent: string): boolean {
	return agent.includes("worker") || agent.includes("implementer");
}

/**
 * Generate a unique effect ID for idempotency.
 * Include repair attempt so retries get distinct IDs.
 */
function effectId(
	runId: string,
	stepIndex: number,
	phase: string,
	repairAttempt: number,
): EffectId {
	return `${runId}:${stepIndex}:${phase}:${repairAttempt}`;
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

/** Check if a state is terminal (absorbs all events). */
function isTerminal(state: WorkflowState): boolean {
	return (
		state.tag === "done" || state.tag === "failed" || state.tag === "cancelled"
	);
}

/** Build the full prompt for a chain step, replacing tokens with accumulated outputs. */
function buildStepPrompt(
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

/** Check if a prompt looks like a task worth routing, vs a conversational follow-up. */
export function isWorkflowTask(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (!trimmed) return false;
	// Very short or question → likely conversational, not a task
	if (trimmed.length < 25) return false;
	if (trimmed.endsWith("?") && trimmed.length < 80) return false;
	// Simple acknowledgments → not a task
	if (
		/^(yes|no|ok|okay|thanks|done|yep|nope|sure|got it|lol|aha)$/i.test(trimmed)
	)
		return false;
	return true;
}

/**
 * Try to parse phase output as JSON. Returns the parsed object or null.
 * The output may be a JSON file or raw text from the agent response.
 */
export function tryParseJson(text: string): Record<string, unknown> | null {
	// Strip markdown code fences if present
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

// ═══════════════════════════════════════════════
// REDUCER
// ═══════════════════════════════════════════════

export interface ReduceResult {
	state: WorkflowState;
	effects: WorkflowEffect[];
}

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

// ── Direct state transitions (D0 only) ──

function reduceDirect(state: DirectState, event: WorkflowEvent): ReduceResult {
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
			return { state, effects: [] }; // ignore — workflow already active
		default:
			return { state, effects: [] };
	}
}

function onDirectPhaseCompleted(
	state: DirectState,
	_event: PhaseCompletedEvent,
): ReduceResult {
	const { chainSteps, chainIndex, runId, originalModelRef } = state;

	// All steps complete → done
	if (chainIndex >= chainSteps.length - 1) {
		return {
			state: { tag: "done", runId, difficulty: "D0" },
			effects: originalModelRef
				? [{ type: "RESTORE_MODEL", modelRef: originalModelRef }]
				: [{ type: "NOOP" }],
		};
	}

	// There should never be multiple steps in D0, but handle it anyway
	const nextIndex = chainIndex + 1;
	const nextState: DirectState = { ...state, chainIndex: nextIndex };
	return dispatchCurrentStep(nextState, nextIndex);
}

// ── Delegated state transitions (D1-D3) ──

function reduceDelegated(
	state: DelegatedState,
	event: WorkflowEvent,
): ReduceResult {
	switch (event.type) {
		case "PHASE_COMPLETED":
			return onDelegatedPhaseCompleted(state, event);
		case "VERIFY_RESULT":
			return processVerifierOutput(state, event);
		case "PHASE_CONTRACT_VIOLATION":
			return {
				state: {
					tag: "failed",
					runId: state.runId,
					difficulty: state.difficulty,
					reason: event.reason,
				},
				effects: [
					{
						type: "NOTIFY",
						message: `🚫 Contract violation: ${event.reason}`,
						level: "error",
					},
				],
			};
		case "CANCELLED":
			return {
				state: { tag: "cancelled", runId: state.runId },
				effects: [
					{ type: "RESTORE_MODEL", modelRef: state.originalModelRef ?? "" },
					{
						type: "NOTIFY",
						message: "⏹️ Workflow cancelled.",
						level: "warning",
					},
				],
			};
		case "START_WORKFLOW":
			return { state, effects: [] }; // ignore
		default:
			return { state, effects: [] };
	}
}

function onDelegatedPhaseCompleted(
	state: DelegatedState,
	event: PhaseCompletedEvent,
): ReduceResult {
	const {
		chainSteps,
		chainIndex,
		runId,
		prompt,
		difficulty,
		outputs,
		originalModelRef,
	} = state;

	// Check if this step agent is a verifier — verifier results are dispatched as VERIFY_RESULT, not PHASE_COMPLETED
	// (This is a safety net: if the extension dispatches PHASE_COMPLETED for a verifier, we re-dispatch)
	if (isVerifier(event.stepAgent)) {
		return processVerifierOutput(state, event);
	}

	const parsed = tryParseJson(event.output);

	// Capture output for next phases
	const step = chainSteps[chainIndex];
	const outputKey = step.as || step.agent;
	const newOutputs = { ...outputs, [outputKey]: event.output };

	// Check for "task already satisfied" in scout output
	if (
		isScout(event.stepAgent) &&
		parsed &&
		parsed.taskAlreadySatisfied === true
	) {
		return {
			state: { tag: "done", runId, difficulty },
			effects: [
				{ type: "RESTORE_MODEL", modelRef: originalModelRef ?? "" },
				{
					type: "NOTIFY",
					message: "✅ Scout determined task is already satisfied.",
					level: "info",
				},
			],
		};
	}

	// Check if scout recommends D0
	if (
		isScout(event.stepAgent) &&
		parsed &&
		parsed.recommendedDifficulty === "D0"
	) {
		// Reroute to direct execution: find worker/implementer step and run it
		const workerStep = chainSteps.find((s) => isWorker(s.agent));
		if (workerStep) {
			const directState: DirectState = {
				tag: "direct",
				runId,
				sessionId: state.sessionId,
				prompt,
				difficulty: "D0",
				chainSteps: [workerStep],
				chainIndex: 0,
				originalModelRef,
			};
			return dispatchCurrentStep(directState, 0);
		}
	}

	// Advance to next step
	const nextIndex = chainIndex + 1;

	// All steps complete → done
	if (nextIndex >= chainSteps.length) {
		return {
			state: { tag: "done", runId, difficulty },
			effects: [
				{ type: "RESTORE_MODEL", modelRef: originalModelRef ?? "" },
				{
					type: "NOTIFY",
					message: "✅ Workflow completed successfully.",
					level: "info",
				},
			],
		};
	}

	const nextState: DelegatedState = {
		...state,
		chainIndex: nextIndex,
		outputs: newOutputs,
	};
	return dispatchCurrentStep(nextState, nextIndex);
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
		return {
			state: {
				tag: "failed",
				runId,
				difficulty,
				reason: "Verifier output missing 'status' field",
			},
			effects: [
				{
					type: "NOTIFY",
					message: "🚫 Verifier output missing status.",
					level: "error",
				},
			],
		};
	}

	return handleVerdict(state, parsed.status === "pass", undefined);
}

function handleVerdict(
	state: DelegatedState,
	passed: boolean,
	reason?: string,
): ReduceResult {
	const {
		runId,
		difficulty,
		chainSteps,
		repairAttempts,
		maxRepairAttempts,
		originalModelRef,
	} = state;

	if (passed) {
		return {
			state: { tag: "done", runId, difficulty },
			effects: [
				{ type: "RESTORE_MODEL", modelRef: originalModelRef ?? "" },
				{ type: "NOTIFY", message: "✅ Verification passed.", level: "info" },
			],
		};
	}

	// Verification failed — check repair budget
	const attemptsLeft = maxRepairAttempts - (repairAttempts + 1); // +1 for this failure

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
					message: `🚫 Verification failed — no repair attempts remaining.`,
					level: "error",
				},
			],
		};
	}

	// Reset chain to the first planner or worker step for the repair cycle.
	// Must also emit RUN_PHASE to kick off the repair, otherwise the
	// workflow gets stuck in "delegated" limbo (no agent is called).
	const repairStartIndex = chainSteps.findIndex(
		(s) => isPlanner(s.agent) || isWorker(s.agent),
	);
	const resetIndex = repairStartIndex >= 0 ? repairStartIndex : 0;

	const repairState: DelegatedState = {
		...state,
		chainIndex: resetIndex,
		repairAttempts: repairAttempts + 1,
	};

	// Build the repair step prompt from the step at resetIndex
	const repairStep = repairState.chainSteps[resetIndex];
	const fullPrompt = repairStep
		? buildStepPrompt(repairStep, repairState.prompt, repairState.outputs)
		: null;

	const effects: WorkflowEffect[] = [
		{
			type: "NOTIFY",
			message: `🔄 Verification failed — repair attempt ${repairAttempts + 1}/${maxRepairAttempts}. Re-running from planning phase.`,
			level: "warning",
		},
	];

	if (repairStep && fullPrompt) {
		const id = effectId(
			repairState.runId,
			resetIndex,
			repairStep.phase,
			repairAttempts + 1,
		);
		effects.push({
			type: "RUN_PHASE",
			effectId: id,
			step: repairStep,
			fullPrompt,
		});
	}

	return {
		state: repairState,
		effects,
	};
}

// ── Phase dispatch helper ──

/**
 * Build the effect to run the current step for a non-terminal active state.
 * Returns the state unchanged and the RUN_PHASE effect.
 */
function dispatchCurrentStep(
	state: DirectState | DelegatedState,
	stepIndex: number,
): ReduceResult {
	const step = state.chainSteps[stepIndex];
	if (!step) {
		const terminal =
			state.tag === "direct"
				? {
						tag: "done" as const,
						runId: state.runId,
						difficulty: state.difficulty,
					}
				: {
						tag: "done" as const,
						runId: state.runId,
						difficulty: state.difficulty,
					};
		return { state: terminal, effects: [] };
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
	const fullPrompt = buildStepPrompt(step, prompt, outputs);

	const effects: WorkflowEffect[] = [
		{ type: "RUN_PHASE", effectId: id, step, fullPrompt },
	];

	return { state, effects };
}
