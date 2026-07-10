/**
 * phenix-flow/types.ts — Discriminated union types for the workflow state machine.
 *
 * Design: typed statechart with a pure reducer.
 * - States are a discriminated union: illegal states are unrepresentable.
 * - Events carry typed payloads, dispatched by the extension adapter.
 * - Effects are commands the extension adapter interprets (set model, run phase, etc.).
 */

// ── Types shared with routing matrix ──
export type Difficulty = "D0" | "D1" | "D2" | "D3";

// ── Chain step (parsed from a .chain.md or .chain.json file) ──
export interface ChainStep {
	agent: string;
	phase: string;
	label: string;
	as?: string;
	output?: string;
	outputMode?: string;
	model?: string;
	thinking?: string;
	contract?: string;
	instruction: string;
}

// ── Effect ID ($runId:$phase:$attempt) for idempotency ──
export type EffectId = string;

// ═══════════════════════════════════════════════
// WORKFLOW STATES (discriminated union)
// ═══════════════════════════════════════════════

/** Idle — no active workflow run. */
export interface IdleState {
	tag: "idle";
}

/** Direct execution (D0 only). Single worker step, no scout/planner/verifier. */
export interface DirectState {
	tag: "direct";
	runId: string;
	prompt: string;
	difficulty: "D0";
	chainSteps: ChainStep[];
	chainIndex: number;
	originalModelRef: string | null;
	completedEffects: EffectId[];
}

/** Delegated execution (D1-D3). Multi-step with scout, plan, verify, optional repair. */
export interface DelegatedState {
	tag: "delegated";
	runId: string;
	prompt: string;
	difficulty: "D1" | "D2" | "D3";
	chainSteps: ChainStep[];
	chainIndex: number;
	repairAttempts: number;
	maxRepairAttempts: number;
	originalModelRef: string | null;
	completedEffects: EffectId[];
	/** Outputs accumulated from completed phases, keyed by step `as` tag. */
	outputs: Record<string, string>;
}

/** Completed successfully. Absorbs all further events. */
export interface DoneState {
	tag: "done";
	runId: string;
	difficulty: Difficulty;
}

/** Terminated with error. Absorbs all further events. */
export interface FailedState {
	tag: "failed";
	runId: string;
	difficulty: Difficulty;
	reason: string;
}

/** Cancelled by user. Absorbs all further events. */
export interface CancelledState {
	tag: "cancelled";
	runId: string;
}

// ── Union ──
export type WorkflowState =
	| IdleState
	| DirectState
	| DelegatedState
	| DoneState
	| FailedState
	| CancelledState;

// ═══════════════════════════════════════════════
// EVENTS (dispatched by the extension adapter)
// ═══════════════════════════════════════════════

/** Start a new workflow run. Chain steps are pre-loaded by the extension. */
export interface StartWorkflowEvent {
	type: "START_WORKFLOW";
	runId: string;
	prompt: string;
	difficulty: Difficulty;
	chainSteps: ChainStep[];
	originalModelRef: string | null;
}

/** A phase completed and produced output. */
export interface PhaseCompletedEvent {
	type: "PHASE_COMPLETED";
	stepAgent: string;
	output: string;
}

/** Phase output failed contract validation. */
export interface PhaseContractViolationEvent {
	type: "PHASE_CONTRACT_VIOLATION";
	stepAgent: string;
	reason: string;
}

/** Verification phase determined pass/fail. Extension parses the verifier output. */
export interface VerifyResultEvent {
	type: "VERIFY_RESULT";
	passed: boolean;
	reason?: string;
}

/** Cancel the current workflow. */
export interface CancelledEvent {
	type: "CANCELLED";
}

/** Explicit done signal. */
export interface DoneEvent {
	type: "DONE";
}

export type WorkflowEvent =
	| StartWorkflowEvent
	| PhaseCompletedEvent
	| PhaseContractViolationEvent
	| VerifyResultEvent
	| CancelledEvent
	| DoneEvent;

// ═══════════════════════════════════════════════
// EFFECTS (commands the extension adapter runs)
// ═══════════════════════════════════════════════

/** Run the next phase: send a user message with the phase instruction. */
export interface RunPhaseEffect {
	type: "RUN_PHASE";
	effectId: EffectId;
	step: ChainStep;
	fullPrompt: string;
}

/** Restore the original model after workflow completes. */
export interface RestoreModelEffect {
	type: "RESTORE_MODEL";
	modelRef: string;
}

/** Show a user notification. */
export interface NotifyEffect {
	type: "NOTIFY";
	message: string;
	level: "info" | "warning" | "error";
}

/** No effect to run (pure state transition). */
export interface NoopEffect {
	type: "NOOP";
}

export type WorkflowEffect =
	| RunPhaseEffect
	| RestoreModelEffect
	| NotifyEffect
	| NoopEffect;
