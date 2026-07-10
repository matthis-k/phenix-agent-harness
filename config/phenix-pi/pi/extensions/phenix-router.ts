/**
 * phenix-router.ts — Phenix Provider Router
 *
 * Registers a `phenix` provider exposing model-set frontends:
 *   phenix/free, phenix/mixed, phenix/opencode-go, phenix/gpt
 *
 * Selecting any phenix/* model triggers auto-routing in phenix-flow/
 * (which checks provider === "phenix").
 *
 * Model ID naming is canonicalised through phenix-core/model-ids.ts.
 */

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	FRONTEND_MODEL_SETS,
	formatModelRef,
	type ModelRef,
} from "./phenix-core/model-ids.js";

const MODEL_SETS: Record<string, ModelRef> = FRONTEND_MODEL_SETS;
const PHENIX_PROVIDER = "phenix";
const ROUTER_API = "phenix-router-api" as Api;
const FRONTEND_MODELS: readonly string[] = Object.keys(MODEL_SETS);

const MODELS = FRONTEND_MODELS.map((id) => ({
	id,
	name: `Phenix ${id}`,
	api: ROUTER_API,
	reasoning: true,
	input: ["text", "image"] as unknown as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
}));

let activeContext: ExtensionContext | undefined;
let currentPhenixModel: string | undefined;

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
			if (!ctx)
				throw new Error("phenix-router has no active Pi extension context");

			const modelSet = MODEL_SETS[model.id] ?? MODEL_SETS.free;
			const concrete = ctx.modelRegistry?.find(
				modelSet.provider,
				modelSet.model,
			);
			if (!concrete) {
				throw new Error(
					`backend model not found: ${modelSet.provider}/${modelSet.model}`,
				);
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(concrete);
			if (!auth.ok)
				throw new Error((auth as any).error ?? "API key resolution failed");

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

function getNextPhenixModel(current: string | undefined): string {
	const idx = current ? FRONTEND_MODELS.indexOf(current) : -1;
	const nextIdx = idx === -1 ? 0 : (idx + 1) % FRONTEND_MODELS.length;
	return FRONTEND_MODELS[nextIdx];
}

async function cyclePhenixModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	const nextId = getNextPhenixModel(currentPhenixModel);
	const model = ctx.modelRegistry.find(PHENIX_PROVIDER, nextId);
	if (!model) {
		ctx.ui.notify(`Phenix model ${nextId} not found`, "error");
		return;
	}
	const success = await pi.setModel(model);
	if (success)
		ctx.ui.notify(
			`Phenix mode: ${nextId} → ${formatModelRef(MODEL_SETS[nextId])}`,
			"info",
		);
	else ctx.ui.notify(`Failed to switch to phenix/${nextId}`, "warning");
}

function updatePhenixStatus(ctx: ExtensionContext) {
	if (currentPhenixModel)
		ctx.ui.setStatus(
			"phenix",
			ctx.ui.theme.fg("accent", `phenix:${currentPhenixModel}`),
		);
	else ctx.ui.setStatus("phenix", undefined);
}

function handleRouterCommand(args: string, ctx: ExtensionContext): void {
	const [sub] = args.trim().split(/\s+/, 1);
	if (sub === "status" || sub === "") {
		const m = ctx.model?.id ?? "unknown";
		ctx.ui.notify(
			`model: phenix/${m}\nroute: ${m} → ${formatModelRef(MODEL_SETS[m] ?? MODEL_SETS.free)}`,
			"info",
		);
	} else if (sub === "routes") {
		ctx.ui.notify(
			FRONTEND_MODELS.map(
				(m) => `  phenix/${m} → ${formatModelRef(MODEL_SETS[m])}`,
			).join("\n"),
			"info",
		);
	} else {
		ctx.ui.notify("usage: /router status|routes", "warning");
	}
}

function handlePhenixCommand(
	args: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const trimmed = args.trim();
	if (trimmed === "" || trimmed === "status") {
		if (!currentPhenixModel) {
			ctx.ui.notify(
				"No phenix model active. Use /phenix <mode> or Ctrl+Shift+M.",
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`Current: phenix/${currentPhenixModel} → ${formatModelRef(MODEL_SETS[currentPhenixModel])}`,
			"info",
		);
		return;
	}
	if (MODEL_SETS[trimmed]) {
		const model = ctx.modelRegistry.find(PHENIX_PROVIDER, trimmed);
		if (!model) {
			ctx.ui.notify(`Phenix model ${trimmed} not found`, "error");
			return;
		}
		void pi.setModel(model).then((ok: boolean) => {
			if (ok)
				ctx.ui.notify(
					`Phenix mode: ${trimmed} → ${formatModelRef(MODEL_SETS[trimmed])}`,
					"info",
				);
			else ctx.ui.notify(`Failed to switch to phenix/${trimmed}`, "warning");
		});
		return;
	}
	ctx.ui.notify(
		`Unknown phenix mode "${trimmed}". Available: ${FRONTEND_MODELS.join(", ")}`,
		"error",
	);
}

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
		description: "Show Phenix routing status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			handleRouterCommand(args, ctx);
		},
	});

	pi.registerCommand("phenix", {
		description: "Show or set phenix mode",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			handlePhenixCommand(args, pi, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle Phenix model modes",
		handler: async (ctx: ExtensionContext) => {
			await cyclePhenixModel(pi, ctx);
		},
	});

	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		activeContext = ctx;
		// Only track the model if it's already phenix — don't auto-activate.
		// If the user explicitly selected a non-phenix model (e.g.
		// opencode-go/deepseek-v4-flash), leave it alone so stock behavior
		// is preserved and phenix-flow prompts don't inject.
		if (ctx.model?.provider === PHENIX_PROVIDER) {
			currentPhenixModel = ctx.model.id;
			updatePhenixStatus(ctx);
		}
	});

	pi.on("before_agent_start", (_event: any, ctx: ExtensionContext) => {
		activeContext = ctx;
	});

	pi.on("model_select", (_ev: any, ctx: ExtensionContext) => {
		if (ctx.model?.provider === PHENIX_PROVIDER) {
			currentPhenixModel = ctx.model.id;
			updatePhenixStatus(ctx);
		} else {
			currentPhenixModel = undefined;
			ctx.ui.setStatus("phenix", undefined);
		}
	});
}
