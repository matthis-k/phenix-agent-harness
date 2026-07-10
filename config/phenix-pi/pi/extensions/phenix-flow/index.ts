/**
 * phenix-flow/index.ts — Thin Pi hook adapter.
 *
 * Hooks dispatch events to the reducer and runs returned effects.
 * No transition logic here — all decisions live in machine.ts.
 *
 * Responsibilities:
 *   input         → detect prompt, classify, dispatch START_WORKFLOW
 *   before_agent_start → inject phase instruction into system prompt
 *   agent_end     → capture phase output, verify contract, record MCP artifact, dispatch event
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
} from "../../lib/phenix-routing-matrix";
import type {
	Difficulty,
	Variant,
	CostMode,
	TargetState,
} from "../../lib/phenix-routing-matrix";
import { reduce } from "./machine";
import { isWorkflowTask, tryParseJson } from "./helpers";
import { buildStepPrompt } from "./prompt-builder";
import { initMcpSession, recordMcpArtifact } from "./handoff";
import { verifyPhaseOutput } from "./phase-contracts";
import { resolveChainFile, parseChainSteps } from "./chain-parser";
import type { WorkflowState, ChainStep } from "./types";

// ── Constants ──
const DEFAULT_VARIANT: Variant = "mixed";
const DEFAULT_COST: CostMode = "balanced";
const DEFAULT_TARGET: TargetState = "dev-wallet";

// ── Module-level state (single run, in-memory) ──
let state: WorkflowState = { tag: "idle" };
let flowJustFinished = false;
let configDir = "";

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

function runEffects(
	effects: import("./types").WorkflowEffect[],
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	for (const effect of effects) {
		if (effect.type === "RUN_PHASE") {
			if (effect.step.model) {
				const parsed = parseModelRef(effect.step.model);
				if (parsed) {
					const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
					if (model) {
						void pi.setModel(model);
					}
				}
			}
			if (effect.step.thinking) {
				try {
					(pi as any).setThinkingLevel?.(effect.step.thinking);
				} catch {
					/* thinking level API may not be available */
				}
			}
			pi.sendUserMessage(effect.fullPrompt, { deliverAs: "followUp" });
		} else if (effect.type === "RESTORE_MODEL") {
			if (effect.modelRef) {
				const parsed = parseModelRef(effect.modelRef);
				if (parsed) {
					const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
					if (model) {
						void pi.setModel(model);
					}
				}
			}
		} else if (effect.type === "NOTIFY") {
			ctx.ui.notify(effect.message, effect.level);
		}
		// ponytail: NOOP needs no handler, it's a pass-through
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
	const sessionId = initMcpSession(runId);

	const event = {
		type: "START_WORKFLOW" as const,
		runId,
		sessionId,
		prompt,
		difficulty,
		chainSteps,
		originalModelRef: modelRefKey(ctx),
	};

	const result = reduce(state, event);
	state = result.state;
	ctx.ui.notify(
		`🚀 Phenix workflow — ${difficulty} | ${cf} | ${chainSteps.length} phases`,
		"info",
	);
	runEffects(result.effects, ctx, pi);
}

// ── Re-send helper for missing output files ──

function resendStep(step: ChainStep, prompt: string, pi: ExtensionAPI): void {
	const outputs =
		state.tag === "delegated"
			? (state as Extract<WorkflowState, { tag: "delegated" }>).outputs
			: {};
	const fullPrompt = buildStepPrompt(step, prompt, outputs);
	pi.sendUserMessage(fullPrompt, { deliverAs: "followUp" });
}

// ═══════════════════════════════════════════════
// EXTENSION ENTRY POINT
// ═══════════════════════════════════════════════

export default function phenixFlow(pi: ExtensionAPI): void {
	// ── Discover config dir from extension path ──
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

	// ── Auto-route phenix model inputs through flow ──
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

		const difficulty = classifyDifficulty(prompt);
		startWorkflow(prompt, difficulty, ctx, pi);
	});

	// ── Inject current phase into system prompt ──
	pi.on("before_agent_start", (ev, _ctx) => {
		const activeState = state;
		if (activeState.tag !== "direct" && activeState.tag !== "delegated") return;

		const step = activeState.chainSteps[activeState.chainIndex];
		if (!step) return;

		const outputs = activeState.tag === "delegated" ? activeState.outputs : {};
		const phasePrompt = buildStepPrompt(step, activeState.prompt, outputs);

		return { systemPrompt: ev.systemPrompt + "\n\n" + phasePrompt };
	});

	// ── After each phase completes ──
	pi.on("agent_end", async (_ev, ctx) => {
		if (state.tag !== "direct" && state.tag !== "delegated") return;

		const activeState = state as Extract<
			WorkflowState,
			{ tag: "direct" | "delegated" }
		>;
		const step = activeState.chainSteps[activeState.chainIndex];
		if (!step) return;

		// ── Capture phase output ──
		const ev = _ev as any;
		const agentText =
			typeof ev.text === "string"
				? ev.text
				: (ev.messages?.at?.(-1)?.content ?? "");
		const output = capturePhaseOutput(step, agentText, ctx.cwd);

		// ── If output file required but missing, re-send the phase ──
		if (step.output) {
			const outputPath = resolve(ctx.cwd, step.output);
			if (!existsSync(outputPath) && !output) {
				resendStep(step, activeState.prompt, pi);
				return;
			}
		}

		// ── Parse JSON and verify contract ──
		const parsed = tryParseJson(output);
		if (step.output && !parsed) {
			// Phase has an output file but didn't produce valid JSON
			const violation = {
				type: "PHASE_CONTRACT_VIOLATION" as const,
				stepAgent: step.agent,
				reason: `${step.agent} output is not valid JSON`,
			};
			const result = reduce(state, violation);
			state = result.state;
			runEffects(result.effects, ctx, pi);
			if (isFinal(state)) flowJustFinished = true;
			return;
		}

		// ── Runtime type verification via phase-contracts config ──
		if (parsed) {
			const missingKeys = verifyPhaseOutput(step.agent, parsed);
			if (missingKeys) {
				const violation = {
					type: "PHASE_CONTRACT_VIOLATION" as const,
					stepAgent: step.agent,
					reason: missingKeys,
				};
				const result = reduce(state, violation);
				state = result.state;
				runEffects(result.effects, ctx, pi);
				if (isFinal(state)) flowJustFinished = true;
				return;
			}

			// ── Record phase artifact via MCP ──
			if (activeState.tag === "delegated" && activeState.sessionId) {
				recordMcpArtifact(
					activeState.sessionId,
					step.label,
					step.phase,
					step.output,
					ctx.cwd,
				);
			}
		}

		// ── Dispatch PHASE_COMPLETED or VERIFY_RESULT ──
		const isVerifier = step.agent.includes("verifier");
		let event;

		if (isVerifier) {
			if (parsed && typeof parsed.status === "string") {
				event = {
					type: "VERIFY_RESULT" as const,
					passed: parsed.status === "pass",
					reason:
						parsed.status === "fail"
							? (parsed.failures as any[])
									?.map((f: any) => f.issue ?? "")
									.filter(Boolean)
									.join("; ") || "Verification failed"
							: undefined,
				};
			} else {
				event = {
					type: "VERIFY_RESULT" as const,
					passed: false,
					reason: "Verifier output missing status",
				};
			}
		} else {
			event = {
				type: "PHASE_COMPLETED" as const,
				stepAgent: step.agent,
				output,
			};
		}

		const result = reduce(state, event);
		state = result.state;
		runEffects(result.effects, ctx, pi);

		if (isFinal(state)) flowJustFinished = true;
	});

	// ── /flow command ──
	pi.registerCommand("flow", {
		description:
			"Route a task through Phenix workflow. Usage: /flow [--difficulty D0|D1|D2|D3] <prompt>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed === "status" || trimmed === "") {
				if (state.tag === "idle") {
					ctx.ui.notify("⏸️ No active flow.", "info");
					return;
				}
				const tag = state.tag;
				ctx.ui.notify(
					`Active flow: ${tag}${
						state.tag === "direct" || state.tag === "delegated"
							? ` | Step ${state.chainIndex + 1}/${state.chainSteps.length}: ${state.chainSteps[state.chainIndex]?.label ?? "?"}`
							: ""
					}`,
					"info",
				);
				return;
			}

			if (trimmed === "cancel") {
				if (state.tag === "idle") {
					ctx.ui.notify("⏸️ No active flow.", "info");
					return;
				}
				const result = reduce(state, { type: "CANCELLED" });
				state = result.state;
				runEffects(result.effects, ctx, pi);
				return;
			}

			const { prompt, difficulty: flagDifficulty } =
				parseDifficultyFlags(trimmed);
			if (!prompt) {
				ctx.ui.notify(
					"Usage: /flow [--difficulty D0|D1|D2|D3] <prompt>",
					"warning",
				);
				return;
			}

			const difficulty = flagDifficulty ?? classifyDifficulty(prompt);
			startWorkflow(prompt, difficulty, ctx, pi);
		},
	});

	// ── Cleanup ──
	(pi as any).on("session_end", () => {
		state = { tag: "idle" };
		flowJustFinished = false;
	});
}

/** Check if a state is terminal. */
function isFinal(s: WorkflowState): boolean {
	return s.tag === "done" || s.tag === "failed" || s.tag === "cancelled";
}
