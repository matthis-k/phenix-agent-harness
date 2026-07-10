/**
 * phenix-flow/index.ts — Thin Pi hook adapter.
 *
 * Hooks dispatch events to the reducer and run returned effects.
 * No transition logic here — all decisions live in machine.ts.
 *
 * Hook responsibilities:
 *   input         → detect prompt, classify, dispatch START_WORKFLOW
 *   before_agent_start → inject current phase instruction into system prompt
 *   agent_end     → capture phase output, dispatch PHASE_COMPLETED / VERIFY_RESULT
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
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
import { reduce, isWorkflowTask, tryParseJson } from "./machine";
import { validatePhaseOutput, detectRole } from "./contracts";
import type { WorkflowState, WorkflowEffect, ChainStep } from "./types";

/**
 * Check if a phase agent has contract requirements.
 */
function hasPhaseContract(agent: string): boolean {
	return detectRole(agent) !== null;
}

/**
 * Write a contract artifact file after Zod validation passes.
 * The contract name is configured via the chain step's `contract` field.
 * Produces a durable JSON file alongside the phase output for traceability.
 */
function writePhaseContract(
	step: ChainStep,
	data: unknown,
	ctx: ExtensionContext,
): void {
	const contractFile = `${step.output ?? "phase-output"}.contract.json`;
	const contractPath = resolve(ctx.cwd, contractFile);
	const contract = {
		contract: step.contract,
		role: detectRole(step.agent),
		agent: step.agent,
		phase: step.phase,
		label: step.label,
		outputFile: step.output,
		validatedAt: new Date().toISOString(),
		data,
	};
	writeFileSync(contractPath, JSON.stringify(contract, null, 2), "utf-8");
}

/**
 * Dispatch a PHASE_CONTRACT_VIOLATION event and check if the run ended.
 * Shared helper for both non-JSON and schema-validation branches.
 */
function dispatchViolation(
	stepAgent: string,
	reason: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	const event = {
		type: "PHASE_CONTRACT_VIOLATION" as const,
		stepAgent,
		reason,
	};
	const result = reduce(state, event);
	state = result.state;
	runEffects(result.effects, ctx, pi);
	if (
		state.tag === "done" ||
		state.tag === "failed" ||
		state.tag === "cancelled"
	) {
		flowJustFinished = true;
	}
}

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

function chainFileName(difficulty: Difficulty, _variant: string): string {
	// ponytail: variant-specific chains not yet used; add when chains diverge per variant
	if (difficulty === "D0") return "phenix-d0";
	if (difficulty === "D3") return "phenix-d3";
	if (difficulty === "D2") return "phenix-d2";
	return "phenix-d1";
}

function chainFilePath(name: string): string | null {
	const candidates = [
		resolve(configDir, "chains", name + ".chain.md"),
		resolve(configDir, "chains", name + ".chain.json"),
	];
	for (const f of candidates) {
		if (existsSync(f)) return f;
	}
	return null;
}

function parseChainSteps(filePath: string, _prompt: string): ChainStep[] {
	const content = readFileSync(filePath, "utf-8").trim();

	if (filePath.endsWith(".json")) {
		try {
			const parsed = JSON.parse(content);
			const raw = parsed.chain ?? [];
			const steps: ChainStep[] = [];
			for (const s of raw) {
				if (s.parallel) {
					for (const p of s.parallel) {
						steps.push({
							agent: p.agent ?? "unknown",
							phase: p.phase ?? "",
							label: p.label ?? "",
							as: p.as,
							output: p.output,
							outputMode: p.outputMode,
							model: p.model,
							thinking: p.thinking,
							contract: p.contract,
							instruction: p.task ?? p.instruction ?? "",
						});
					}
				} else {
					steps.push({
						agent: s.agent ?? "unknown",
						phase: s.phase ?? "",
						label: s.label ?? "",
						as: s.as,
						output: s.output,
						outputMode: s.outputMode,
						model: s.model,
						thinking: s.thinking,
						contract: s.contract,
						instruction: s.task ?? s.instruction ?? "",
					});
				}
			}
			return steps;
		} catch {
			return [];
		}
	}

	// Markdown chain format: ## <agent-name>\nkey: value\n\nbody
	const steps: ChainStep[] = [];
	// Use chain.json stopping pattern — not needed for markdown
	const blocks = content.split(/^## /m).slice(1);
	for (const block of blocks) {
		const lines = block.split("\n");
		const agent = lines[0]?.trim() ?? "unknown";
		const bodyStart = lines.findIndex(
			(l: string) => l.trim() && !l.includes(":"),
		);
		const headerLines = lines.slice(1, bodyStart > 0 ? bodyStart : undefined);
		const bodyLines = bodyStart > 0 ? lines.slice(bodyStart) : lines.slice(1);

		const getVal = (key: string): string | undefined => {
			const prefix = `${key}:`;
			for (const l of headerLines) {
				if (l.startsWith(prefix)) return l.slice(prefix.length).trim();
			}
			return undefined;
		};

		steps.push({
			agent,
			phase: getVal("phase") ?? "",
			label: getVal("label") ?? "",
			as: getVal("as"),
			output: getVal("output"),
			outputMode: getVal("outputMode"),
			model: getVal("model"),
			thinking: getVal("thinking"),
			contract: getVal("contract"),
			instruction: bodyLines.join("\n").trim(),
		});
	}

	return steps;
}

function runEffects(
	effects: WorkflowEffect[],
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
			pi.sendUserMessage(effect.fullPrompt, {
				deliverAs: "followUp",
			});
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
		/* file may not exist */
	}
	return null;
}

/**
 * Try to parse the phase's output: first try the output file, then fall back
 * to the agent response text.
 */
function capturePhaseOutput(
	step: ChainStep,
	agentResponse: string,
	cwd: string,
): string {
	// First try reading the output file
	const fileContent = tryReadOutputFile(cwd, step.output);
	if (fileContent) return fileContent;
	// Fall back to agent response
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
	const chainName = chainFileName(difficulty, variant ?? DEFAULT_VARIANT);
	const cf = chainFilePath(chainName);
	if (!cf) {
		ctx.ui.notify(`Chain file not found: ${chainName}`, "warning");
		return;
	}

	const chainSteps = parseChainSteps(cf, prompt);
	if (chainSteps.length === 0) {
		ctx.ui.notify(`Empty chain: ${chainName}`, "warning");
		return;
	}

	// Check routing matrix for denials
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

	const event = {
		type: "START_WORKFLOW" as const,
		runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		prompt,
		difficulty,
		chainSteps,
		originalModelRef: modelRefKey(ctx),
	};

	const result = reduce(state, event);
	state = result.state;
	ctx.ui.notify(
		`🚀 Phenix workflow — ${difficulty} | Chain: ${chainName} | ${chainSteps.length} phases`,
		"info",
	);
	runEffects(result.effects, ctx, pi);
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
		if (state.tag !== "idle") return; // workflow already active
		if (!ev.text || ev.text.startsWith("/")) return;

		const prompt = ev.text;

		// Guard: don't auto-route conversational prompts
		if (!isWorkflowTask(prompt)) return;

		const difficulty = classifyDifficulty(prompt);
		startWorkflow(prompt, difficulty, ctx, pi);
	});

	// ── Inject current phase into system prompt and set model/thinking ──
	pi.on("before_agent_start", (ev, _ctx) => {
		const activeState = state;
		if (activeState.tag !== "direct" && activeState.tag !== "delegated") return;

		const step = activeState.chainSteps[activeState.chainIndex];
		if (!step) return;

		// Build step prompt
		const outputs = activeState.tag === "delegated" ? activeState.outputs : {};
		let instruction = step.instruction;
		instruction = instruction.replace(/\{outputs\.(\w+)\}/g, (_match, key) => {
			if (outputs[key]) return outputs[key];
			return `(output from ${key} phase)`;
		});
		instruction = instruction.replace(/\{previous\}/g, activeState.prompt);

		const parts: string[] = [
			"## Phenix Workflow Phase",
			"",
			`Task: ${activeState.prompt}`,
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

		return { systemPrompt: ev.systemPrompt + "\n\n" + parts.join("\n") };
	});

	// ── After each phase completes, capture output and dispatch event ──
	pi.on("agent_end", async (_ev, ctx) => {
		if (state.tag !== "direct" && state.tag !== "delegated") return;

		const activeState = state as Extract<
			WorkflowState,
			{ tag: "direct" | "delegated" }
		>;
		const step = activeState.chainSteps[activeState.chainIndex];
		if (!step) return;

		// Capture output from the completed phase
		// AgentEndEvent has `messages` — extract text from the last message
		const ev = _ev as any;
		const agentText =
			typeof ev.text === "string"
				? ev.text
				: (ev.messages?.at?.(-1)?.content ?? "");
		const output = capturePhaseOutput(step, agentText, ctx.cwd);

		// If output file is required but missing, re-send same phase
		if (step.output) {
			const outputPath = resolve(ctx.cwd, step.output);
			if (!existsSync(outputPath) && !output) {
				// Agent didn't write the file — give it another turn with the same instruction
				const outputs =
					state.tag === "delegated"
						? (state as Extract<WorkflowState, { tag: "delegated" }>).outputs
						: {};
				const fullPrompt = buildInlineStepPrompt(
					step,
					activeState.prompt,
					outputs,
				);
				pi.sendUserMessage(fullPrompt, {
					deliverAs: "followUp",
				});
				return;
			}
		}

		// Gate: pre-validate phase output contract at adapter boundary
		// If contract validation fails, dispatch PHASE_CONTRACT_VIOLATION instead of PHASE_COMPLETED
		if (hasPhaseContract(step.agent)) {
			const parsed = tryParseJson(output);
			if (!parsed) {
				// Phase has a contract but output isn't valid JSON — this is a violation
				dispatchViolation(
					step.agent,
					`${step.agent} output is not valid JSON`,
					ctx,
					pi,
				);
				return;
			}
			const validation = validatePhaseOutput(step.agent, parsed);
			if (!validation.success) {
				dispatchViolation(step.agent, validation.reason, ctx, pi);
				return;
			}
			// After Zod validation passes, write contract artifact if configured
			if (step.contract) {
				writePhaseContract(step, validation.data, ctx);
			}
		}

		// Determine event type based on agent role
		const isVerifier = step.agent.includes("verifier");
		let event;

		if (isVerifier) {
			// Parse verifier output to determine pass/fail
			const parsed = tryParseJson(output);
			if (parsed && typeof parsed.status === "string") {
				event = {
					type: "VERIFY_RESULT" as const,
					passed: parsed.status === "pass",
					reason:
						parsed.status === "fail"
							? ((parsed.failures as any[])
									?.map((f: any) => f.description)
									.join("; ") ?? "Verification failed")
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

		// If done/failed/cancelled, mark justFinished to prevent re-triggering
		if (
			state.tag === "done" ||
			state.tag === "failed" ||
			state.tag === "cancelled"
		) {
			flowJustFinished = true;
		}
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

// ── Inline helpers (not exported from machine) ──

function buildInlineStepPrompt(
	step: ChainStep,
	prompt: string,
	outputs: Record<string, string>,
): string {
	let instruction = step.instruction;
	instruction = instruction.replace(/\{outputs\.(\w+)\}/g, (_match, key) => {
		if (outputs[key]) return outputs[key];
		return `(output from ${key} phase)`;
	});
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
