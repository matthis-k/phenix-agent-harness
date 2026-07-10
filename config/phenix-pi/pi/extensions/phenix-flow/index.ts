/**
 * phenix-flow/index.ts — Thin Pi hook adapter.
 *
 * Hooks dispatch events to the reducer and runs returned effects.
 * No transition logic here — all decisions live in machine.ts.
 *
 * Responsibilities:
 *   input         → detect prompt, classify, dispatch START_WORKFLOW
 *   before_agent_start → inject phase instruction into system prompt
 *   agent_end     → capture phase output, check for accepted handoff, dispatch event
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	classifyDifficulty,
	resolveWorkflowRoute,
} from "../../lib/phenix-routing-matrix.js";
import type {
	Difficulty,
	Variant,
	CostMode,
	TargetState,
} from "../../lib/phenix-routing-matrix.js";
import { reduce } from "./machine.js";
import { isWorkflowTask, tryParseJson } from "./helpers.js";
import { buildStepPrompt, type HandoffIdentity } from "./prompt-builder.js";
import { resolveChainFile, parseChainSteps } from "./chain-parser.js";
import {
	registerHandoffTool,
	setToolState,
	clearToolState,
	consumePendingArtifact,
} from "./handoff/tool.js";
import type {
	WorkflowState,
	ChainStep,
	DelegatedState,
	AwaitingHandoffState,
	WorkflowEvent,
	ReduceResult,
	WorkflowEffect,
} from "./types.js";

// ── Minimal event type for agent_end handler ──
interface AgentEndMessage {
	content?: string;
}

interface AgentEndEvent {
	text?: string;
	messages?: AgentEndMessage[];
}

// ── Constants ──
const DEFAULT_VARIANT: Variant = "mixed";
const DEFAULT_COST: CostMode = "balanced";
const DEFAULT_TARGET: TargetState = "dev-wallet";

// ── Module-level state (single run, in-memory) ──
let state: WorkflowState = { tag: "idle" };
let flowJustFinished = false;
let configDir = "";

// ── Dispatch helper: reduce + update tool state ──

/**
 * Dispatch an event to the reducer, update state, and update tool state reference.
 * Always use this instead of calling reduce() directly from hooks.
 */
/** Extract criterion IDs from a plan JSON string. */
function getPlanCriterionIds(planOutput: string | undefined): string[] {
	if (!planOutput) return [];
	try {
		const plan = JSON.parse(planOutput);
		if (plan.acceptanceCriteria) {
			return plan.acceptanceCriteria
				.map((ac: { id: string }) => ac.id)
				.filter(Boolean);
		}
	} catch {
		// Plan may not be JSON — ignore
	}
	return [];
}

function dispatch(
	event: WorkflowEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): ReduceResult {
	const result = reduce(state, event);
	state = result.state;

	// Update tool state reference for awaiting-handoff
	if (state.tag === "awaiting-handoff") {
		const s = state as AwaitingHandoffState;
		setToolState({
			getState: () => s,
			getPlanCriterionIds: () => getPlanCriterionIds(s.outputs?.plan),
		});
	} else {
		clearToolState();
	}

	runEffects(result.effects, ctx, pi);

	return result;
}

// ── Helpers ──

function isPhenixModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "phenix";
}

function modelRefKey(ctx: ExtensionContext): string | null {
	if (!ctx.model) return null;
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function parseModelRef(
	ref: string,
): { provider: string; model: string } | null {
	const slash = ref.indexOf("/");
	if (slash === -1) return null;
	return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function runEffect(
	effect: WorkflowEffect,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	if (effect.type === "RUN_PHASE") {
		applyModel(effect.step.model, ctx, pi);
		applyThinking(effect.step.thinking, pi);
		pi.sendUserMessage(effect.fullPrompt, { deliverAs: "followUp" });
	} else if (effect.type === "RESTORE_MODEL") {
		applyModel(effect.modelRef, ctx, pi);
	} else if (effect.type === "NOTIFY") {
		ctx.ui.notify(effect.message, effect.level);
	}
}

function applyModel(
	modelRef: string | undefined | null,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	if (!modelRef) return;
	const parsed = parseModelRef(modelRef);
	if (!parsed) return;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
	if (model) void pi.setModel(model);
}

function applyThinking(thinking: string | undefined, pi: ExtensionAPI): void {
	if (!thinking) return;
	try {
		(
			pi as ExtensionAPI & { setThinkingLevel?: (level: string) => void }
		).setThinkingLevel?.(thinking);
	} catch {
		/* thinking level API may not be available */
	}
}

function runEffects(
	effects: WorkflowEffect[],
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	for (const effect of effects) {
		runEffect(effect, ctx, pi);
	}
}

function tryReadOutputFile(cwd: string, outputPath?: string): string | null {
	if (!outputPath) return null;
	try {
		const filePath = resolve(cwd, outputPath);
		if (existsSync(filePath)) {
			return readFileSync(filePath, "utf-8");
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Capture phase output: try the output file first, fall back to agent response text.
 */
function capturePhaseOutput(
	step: ChainStep,
	agentResponse: string,
	cwd: string,
): string {
	const fileContent = tryReadOutputFile(cwd, step.output);
	if (fileContent) return fileContent;
	return agentResponse;
}

function parseDifficultyFlags(args: string): {
	prompt: string;
	difficulty: Difficulty | null;
} {
	let remaining = args;
	const diffMatch = remaining.match(/--difficulty\s+(D[0-3])/i);
	const difficulty = diffMatch
		? (diffMatch[1].toUpperCase() as Difficulty)
		: null;
	if (diffMatch) remaining = remaining.replace(/--difficulty\s+D[0-3]\s*/i, "");
	remaining = remaining.replace(/--\S+\s*/g, "").trim();
	return { prompt: remaining, difficulty };
}

function startWorkflow(
	prompt: string,
	difficulty: Difficulty,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	variant?: Variant,
): void {
	const cf = resolveChainFile(difficulty, configDir);
	if (!cf) {
		ctx.ui.notify(
			`Chain file not found for difficulty ${difficulty}`,
			"warning",
		);
		return;
	}

	const chainSteps = parseChainSteps(cf);
	if (chainSteps.length === 0) {
		ctx.ui.notify(`Empty chain file: ${cf}`, "warning");
		return;
	}

	const route = resolveWorkflowRoute({
		variant: variant ?? DEFAULT_VARIANT,
		difficulty,
		costMode: DEFAULT_COST,
		secrecy: "public",
		changeKind: "feature",
		targetState: DEFAULT_TARGET,
	});

	if (!route.allowed) {
		ctx.ui.notify(
			`🚫 Flow denied: ${route.denialReason ?? "Not allowed."}`,
			"error",
		);
		return;
	}

	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const sessionId = runId; // Use runId as sessionId (no MCP)

	const event = {
		type: "START_WORKFLOW" as const,
		runId,
		sessionId,
		prompt,
		difficulty,
		chainSteps,
		originalModelRef: modelRefKey(ctx),
	};

	dispatch(event, ctx, pi);
	ctx.ui.notify(
		`🚀 Phenix workflow — ${difficulty} | ${cf} | ${chainSteps.length} phases`,
		"info",
	);
}

// ═══════════════════════════════════════════════
// EXTENSION ENTRY POINT
// ═══════════════════════════════════════════════

function setupSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", (_ev, ctx) => {
		const extUrl = import.meta.url;
		if (extUrl) {
			const extPath = extUrl.startsWith("file://") ? extUrl.slice(7) : extUrl;
			configDir = resolve(dirname(extPath), "..", "..");
		} else {
			configDir = ctx.cwd;
		}
		state = { tag: "idle" };
	});
}

function setupInputHandler(pi: ExtensionAPI): void {
	pi.on("input", (ev, ctx) => {
		if (!isPhenixModel(ctx)) return;
		if (flowJustFinished) {
			flowJustFinished = false;
			return;
		}
		if (state.tag !== "idle") return;
		if (!ev.text || ev.text.startsWith("/")) return;
		const prompt = ev.text;
		if (!isWorkflowTask(prompt)) return;
		startWorkflow(prompt, classifyDifficulty(prompt), ctx, pi);
	});
}

function setupBeforeAgentStart(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (ev, _ctx) => {
		const activeState = state;
		if (activeState.tag !== "direct" && activeState.tag !== "awaiting-handoff")
			return;
		const step = activeState.chainSteps[activeState.chainIndex];
		if (!step) return;
		const outputs = "outputs" in activeState ? activeState.outputs : {};
		let identity: HandoffIdentity | undefined;
		if (activeState.tag === "awaiting-handoff") {
			const ah = activeState as AwaitingHandoffState;
			identity = {
				runId: ah.runId,
				stepId: ah.expected.stepId,
				effectId: ah.expected.effectId,
				attempt: ah.expected.attempt,
			};
		}
		return {
			systemPrompt:
				ev.systemPrompt +
				"\n\n" +
				buildStepPrompt(step, activeState.prompt, outputs, identity),
		};
	});
}

/** Handle a phase end event: capture output, check handoff, advance workflow. */
function onPhaseEnd(
	state: WorkflowState,
	step: ChainStep,
	_ev: unknown,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	const ev = _ev as AgentEndEvent;
	const agentText =
		typeof ev.text === "string"
			? ev.text
			: (ev.messages?.at?.(-1)?.content ?? "");
	const output = capturePhaseOutput(step, agentText, ctx.cwd);

	// If output file required but missing, re-send the phase
	if (step.output) {
		const outputPath = resolve(ctx.cwd, step.output);
		if (!existsSync(outputPath) && !output) {
			resendStep(step, (state as { prompt: string }).prompt, pi);
			return;
		}
	}

	// Check for accepted handoff
	if (state.tag === "awaiting-handoff") {
		const artifact = consumePendingArtifact();
		if (artifact) {
			dispatch(
				{ type: "HANDOFF_ACCEPTED" as const, artifact, phaseOutput: output },
				ctx,
				pi,
			);
			clearToolState();
			if (isFinal(state)) flowJustFinished = true;
		} else {
			dispatch(
				{ type: "PHASE_COMPLETED" as const, stepAgent: step.agent, output },
				ctx,
				pi,
			);
			clearToolState();
			if (isFinal(state)) flowJustFinished = true;
		}
		return;
	}

	// D0 direct path
	const parsed = tryParseJson(output);
	if (step.output && !parsed) {
		dispatch(
			{
				type: "PHASE_CONTRACT_VIOLATION" as const,
				stepAgent: step.agent,
				reason: `${step.agent} output is not valid JSON`,
			},
			ctx,
			pi,
		);
		if (isFinal(state)) flowJustFinished = true;
		return;
	}
	dispatch(
		{ type: "PHASE_COMPLETED" as const, stepAgent: step.agent, output },
		ctx,
		pi,
	);
	if (isFinal(state)) flowJustFinished = true;
}

function setupAgentEnd(pi: ExtensionAPI): void {
	pi.on("agent_end", (_ev, ctx) => {
		if (state.tag !== "direct" && state.tag !== "awaiting-handoff") return;
		const activeState = state as Extract<
			WorkflowState,
			{ tag: "direct" | "awaiting-handoff" }
		>;
		const step = activeState.chainSteps[activeState.chainIndex];
		if (!step) return;
		onPhaseEnd(state, step, _ev, ctx, pi);
	});
}

function setupFlowCommand(extPi: ExtensionAPI): void {
	extPi.registerCommand("flow", {
		description:
			"Route a task through Phenix workflow. Usage: /flow [--difficulty D0|D1|D2|D3] <prompt>",
		handler: (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed === "status" || trimmed === "") {
				if (state.tag === "idle") {
					ctx.ui.notify("⏸️ No active flow.", "info");
					return Promise.resolve();
				}
				const tag = state.tag;
				const chainIndex = "chainIndex" in state ? state.chainIndex : -1;
				const chainSteps = "chainSteps" in state ? state.chainSteps : [];
				ctx.ui.notify(
					`Active flow: ${tag}${
						chainIndex >= 0
							? ` | Step ${chainIndex + 1}/${chainSteps.length}: ${chainSteps[chainIndex]?.label ?? "?"}`
							: ""
					}`,
					"info",
				);
				return Promise.resolve();
			}

			if (trimmed === "cancel") {
				if (state.tag === "idle") {
					ctx.ui.notify("⏸️ No active flow.", "info");
					return Promise.resolve();
				}
				dispatch({ type: "CANCELLED" }, ctx, extPi);
				return Promise.resolve();
			}

			const { prompt, difficulty: flagDifficulty } =
				parseDifficultyFlags(trimmed);
			if (!prompt) {
				ctx.ui.notify(
					"Usage: /flow [--difficulty D0|D1|D2|D3] <prompt>",
					"warning",
				);
				return Promise.resolve();
			}

			const difficulty = flagDifficulty ?? classifyDifficulty(prompt);
			startWorkflow(prompt, difficulty, ctx, extPi);
			return Promise.resolve();
		},
	});
}

function setupCleanup(extPi: ExtensionAPI): void {
	extPi.on("session_end" as "input", () => {
		state = { tag: "idle" };
		flowJustFinished = false;
		clearToolState();
	});
}

export default function phenixFlow(pi: ExtensionAPI): void {
	registerHandoffTool(pi);
	setupSessionStart(pi);
	setupInputHandler(pi);
	setupBeforeAgentStart(pi);
	setupAgentEnd(pi);
	setupFlowCommand(pi);
	setupCleanup(pi);
}

/** Check if a state is terminal. */
function isFinal(s: WorkflowState): boolean {
	return s.tag === "done" || s.tag === "failed" || s.tag === "cancelled";
}

/**
 * Re-send a step prompt (for missing output files).
 */
function resendStep(step: ChainStep, prompt: string, pi: ExtensionAPI): void {
	const outputs =
		state.tag === "awaiting-handoff" || state.tag === "delegated"
			? ((state as DelegatedState | AwaitingHandoffState).outputs ?? {})
			: {};

	let identity: HandoffIdentity | undefined;
	if (state.tag === "awaiting-handoff") {
		const ah = state as AwaitingHandoffState;
		identity = {
			runId: ah.runId,
			stepId: ah.expected.stepId,
			effectId: ah.expected.effectId,
			attempt: ah.expected.attempt,
		};
	}

	const fullPrompt = buildStepPrompt(step, prompt, outputs, identity);
	pi.sendUserMessage(fullPrompt, { deliverAs: "followUp" });
}
