/**
 * phenix-router.ts — Phenix Provider Router
 *
 * Registers a `phenix` provider with Pi that exposes model-set frontends:
 *   phenix/free        → opencode/deepseek-v4-flash-free
 *   phenix/mixed       → opencode/deepseek-v4-flash
 *   phenix/opencode-go → opencode/deepseek-v4-flash
 *   phenix/gpt         → openai/gpt-5.5
 *
 * Selecting any phenix/* model triggers the Phenix multi-agent workflow
 * autostart in phenix-flow.ts (via isPhenixModel() which checks
 * provider === "phenix").
 *
 * Per-role model resolution (planner/worker/verifier get different models)
 * is handled by the subagent executor's resolveSubagentModel() using the
 * routing matrix — not by this provider. This provider simply bridges
 * the chat stream to a default backend model for the selected model set.
 */

import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

// ──────────────────────────────────────────────
// Model set definitions
// ──────────────────────────────────────────────

interface ModelSetRef {
	provider: string;
	model: string;
}

const MODEL_SETS: Record<string, ModelSetRef> = {
	free:        { provider: "opencode", model: "deepseek-v4-flash-free" },
	mixed:       { provider: "opencode", model: "deepseek-v4-flash" },
	"opencode-go": { provider: "opencode", model: "deepseek-v4-flash" },
	gpt:         { provider: "openai",   model: "gpt-5.5" },
};

const PHENIX_PROVIDER = "phenix";
const ROUTER_API = "phenix-router-api" as Api;

const FRONTEND_MODELS: readonly string[] = Object.keys(MODEL_SETS);

const MODELS = FRONTEND_MODELS.map((id) => ({
	id,
	name: `Phenix ${id}`,
	api: ROUTER_API,
	reasoning: true,
	input: ["text", "image"] as const,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
}));

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────

let activeContext: ExtensionContext | undefined;
let currentPhenixModel: string | undefined;

// ──────────────────────────────────────────────
// Stream function — dispatches to backend model
// ──────────────────────────────────────────────

function routerStream(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: Date.now(),
		};

		try {
			const ctx = activeContext;
			if (!ctx) throw new Error("phenix-router has no active Pi extension context");

			const modelSet = MODEL_SETS[model.id] ?? MODEL_SETS.free;
			const concrete = ctx.modelRegistry?.find(modelSet.provider, modelSet.model);
			if (!concrete) {
				throw new Error(
					`backend model not found: ${modelSet.provider}/${modelSet.model}`,
				);
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(concrete);
			if (!auth.ok) throw new Error(auth.error);

			const upstream = streamSimple(concrete, context, {
				...options,
				apiKey: auth.apiKey,
				headers:
					auth.headers || options?.headers
						? { ...auth.headers, ...options?.headers }
						: undefined,
				env:
					auth.env || options?.env
						? { ...auth.env, ...options?.env }
						: undefined,
			});

			for await (const event of upstream) stream.push(event);
			stream.end(await upstream.result());
		} catch (error) {
			output.errorMessage =
				error instanceof Error ? error.message : String(error);
			calculateCost(model, output.usage);
			stream.push({ type: "start", partial: output });
			stream.push({
				type: "error",
				reason: options?.signal?.aborted ? "aborted" : "error",
				error: output,
			});
			stream.end();
		}
	})();

	return stream;
}

// ──────────────────────────────────────────────
// Phenix model cycling
// ──────────────────────────────────────────────

function getNextPhenixModel(current: string | undefined): string {
	const idx = current ? FRONTEND_MODELS.indexOf(current) : -1;
	const nextIdx = idx === -1 ? 0 : (idx + 1) % FRONTEND_MODELS.length;
	return FRONTEND_MODELS[nextIdx];
}

async function cyclePhenixModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const nextId = getNextPhenixModel(currentPhenixModel);
	const model = ctx.modelRegistry.find(PHENIX_PROVIDER, nextId);
	if (!model) {
		ctx.ui.notify(`Phenix model ${nextId} not found`, "error");
		return;
	}
	const success = await pi.setModel(model);
	if (success) {
		const modelSet = MODEL_SETS[nextId];
		ctx.ui.notify(
			`Phenix mode: ${nextId} → ${modelSet.provider}/${modelSet.model}`,
			"info",
		);
	} else {
		ctx.ui.notify(`Failed to switch to phenix/${nextId}`, "warning");
	}
}

function updatePhenixStatus(ctx: ExtensionContext) {
	if (currentPhenixModel) {
		ctx.ui.setStatus(
			"phenix",
			ctx.ui.theme.fg("accent", `phenix:${currentPhenixModel}`),
		);
	} else {
		ctx.ui.setStatus("phenix", undefined);
	}
}

// ──────────────────────────────────────────────
// /router command
// ──────────────────────────────────────────────

function handleRouterCommand(args: string, ctx: ExtensionContext): void {
	const [sub] = args.trim().split(/\s+/, 1);

	if (sub === "status" || sub === "") {
		const currentModel = ctx.model?.id ?? "unknown";
		const modelSet = MODEL_SETS[currentModel] ?? MODEL_SETS.free;
		const lines = [
			`enabled: true`,
			`model: phenix/${currentModel}`,
			`route: ${currentModel} → ${modelSet.provider}/${modelSet.model}`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
	} else if (sub === "routes") {
		const lines = FRONTEND_MODELS.map(
			(m) => `  phenix/${m} → ${MODEL_SETS[m].provider}/${MODEL_SETS[m].model}`,
		);
		ctx.ui.notify(`Available routes:\n${lines.join("\n")}`, "info");
	} else {
		ctx.ui.notify("usage: /router status|routes", "warning");
	}
}

// ──────────────────────────────────────────────
// /phenix command
// ──────────────────────────────────────────────

function handlePhenixCommand(args: string, pi: ExtensionAPI, ctx: ExtensionContext): void {
	const trimmed = args.trim();

	if (trimmed === "" || trimmed === "status") {
		if (!currentPhenixModel) {
			ctx.ui.notify("No phenix model active. Use /phenix <mode> or Ctrl+Shift+M to cycle.", "warning");
			return;
		}
		const modelSet = MODEL_SETS[currentPhenixModel];
		ctx.ui.notify(
			`Current: phenix/${currentPhenixModel} → ${modelSet.provider}/${modelSet.model}`,
			"info",
		);
		return;
	}

	// Direct mode selection: /phenix free | /phenix mixed | etc.
	if (MODEL_SETS[trimmed]) {
		const model = ctx.modelRegistry.find(PHENIX_PROVIDER, trimmed);
		if (!model) {
			ctx.ui.notify(`Phenix model ${trimmed} not found`, "error");
			return;
		}
		void (async () => {
			const success = await pi.setModel(model);
			if (success) {
				const modelSet = MODEL_SETS[trimmed];
				ctx.ui.notify(
					`Phenix mode: ${trimmed} → ${modelSet.provider}/${modelSet.model}`,
					"info",
				);
			} else {
				ctx.ui.notify(`Failed to switch to phenix/${trimmed}`, "warning");
			}
		})();
		return;
	}

	const available = FRONTEND_MODELS.join(", ");
	ctx.ui.notify(`Unknown phenix mode "${trimmed}". Available: ${available}`, "error");
}

// ──────────────────────────────────────────────
// Extension entry point
// ──────────────────────────────────────────────

export default function phenixRouter(pi: ExtensionAPI): void {
	pi.registerProvider(PHENIX_PROVIDER, {
		name: "Phenix Router",
		baseUrl: "https://phenix.local/router",
		apiKey: "phenix-router-local",
		api: ROUTER_API,
		streamSimple: routerStream,
		models: MODELS,
	});

	pi.registerCommand("router", {
		name: "router",
		description: "Show or inspect Phenix routing status",
		usage: "/router status|routes",
		handler: (args, ctx) => handleRouterCommand(args, ctx),
	});

	pi.registerCommand("phenix", {
		name: "phenix",
		description: "Show phenix mode or switch to a specific mode",
		usage: "/phenix status|free|mixed|opencode-go|gpt",
		handler: (args, ctx) => handlePhenixCommand(args, pi, ctx),
	});

	// Ctrl+Shift+M — cycle phenix models
	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle Phenix model modes",
		handler: async (ctx) => {
			await cyclePhenixModel(pi, ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		activeContext = ctx;

		if (ctx.model?.provider === PHENIX_PROVIDER) {
			currentPhenixModel = ctx.model.id;
			updatePhenixStatus(ctx);
		} else if (event.reason === "startup" || event.reason === "new") {
			// Default to phenix/opencode-go on fresh sessions
			const defaultModel = ctx.modelRegistry.find(PHENIX_PROVIDER, "opencode-go");
			if (defaultModel) {
				const success = await pi.setModel(defaultModel);
				if (success) {
					currentPhenixModel = "opencode-go";
					updatePhenixStatus(ctx);
				}
			}
		}
	});

	pi.on("before_agent_start", (_event, ctx) => {
		activeContext = ctx;
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.model?.provider === PHENIX_PROVIDER) {
			currentPhenixModel = ctx.model.id;
			updatePhenixStatus(ctx);
		} else {
			currentPhenixModel = undefined;
			ctx.ui.setStatus("phenix", undefined);
		}
	});
}
