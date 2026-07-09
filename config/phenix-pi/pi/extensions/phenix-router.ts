import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyAndRoute, resolveRouting, type RoutingResult } from "../lib/phenix-routing-matrix";

// Frontend model IDs — the user's model selection IS the routing.
// Selecting phenix/free routes to opencode/deepseek-v4-flash-free.
// Selecting phenix/opencode-go routes to opencode/deepseek-v4-flash.
type FrontendModel = "auto" | "free" | "mixed" | "opencode-go" | "gpt";

interface ConcreteModelRef {
	provider: string;
	model: string;
}

interface SlotModels {
	planner: ConcreteModelRef;
	worker: ConcreteModelRef;
	verifier: ConcreteModelRef;
}

interface RouterConfig {
	version: 1;
	enabled: boolean;
	slots: Record<FrontendModel, SlotModels>;
}

interface ResolvedRoute {
	frontend: `phenix/${string}`;
	target: ConcreteModelRef;
	valid: boolean;
	validationMessage?: string;
}

const PHENIX_PROVIDER = "phenix";
const ROUTER_API = "phenix-router-api" as Api;

const FRONTEND_MODELS: readonly FrontendModel[] = ["auto", "free", "mixed", "opencode-go", "gpt"] as const;

const FREE_MODEL: ConcreteModelRef = { provider: "opencode", model: "deepseek-v4-flash-free" };
const GO_MODEL: ConcreteModelRef = { provider: "opencode", model: "deepseek-v4-flash" };

const defaultConfig: RouterConfig = {
	version: 1,
	enabled: true,
	slots: {
		auto: { planner: FREE_MODEL, worker: FREE_MODEL, verifier: FREE_MODEL },
		free: { planner: FREE_MODEL, worker: FREE_MODEL, verifier: FREE_MODEL },
		mixed: {
			planner: { provider: "openai", model: "gpt-5.5" },
			worker: { provider: "opencode", model: "deepseek-v4-flash-free" },
			verifier: { provider: "openai", model: "gpt-5.5" },
		},
		"opencode-go": {
			planner: GO_MODEL,
			worker: GO_MODEL,
			verifier: GO_MODEL,
		},
		gpt: {
			planner: { provider: "openai", model: "gpt-5.5" },
			worker: { provider: "openai", model: "gpt-5.5" },
			verifier: { provider: "openai", model: "gpt-5.5" },
		},
	},
};

let config: RouterConfig = defaultConfig;
let activeContext: ExtensionContext | undefined;
let piRef: ExtensionAPI | undefined;

function readJson(path: string): Partial<RouterConfig> | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
}

function mergeSlotOverrides(base: SlotModels, override: Partial<SlotModels> | undefined): SlotModels {
	if (!override) return base;
	return { ...base, ...override };
}

function loadConfig(ctx?: ExtensionContext): RouterConfig {
	const globalPath = join(getAgentDir(), "extensions", "phenix-router.routes.json");
	const projectPath = ctx?.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "phenix-router.routes.json") : undefined;
	let cfg = { ...defaultConfig };
	const globalOverride = readJson(globalPath);
	if (globalOverride?.slots) {
		for (const mode of Object.keys(globalOverride.slots)) {
			if (cfg.slots[mode as FrontendModel]) {
				cfg.slots[mode as FrontendModel] = mergeSlotOverrides(cfg.slots[mode as FrontendModel], globalOverride.slots[mode as FrontendModel]);
			}
		}
	}
	if (projectPath) {
		const projectOverride = readJson(projectPath);
		if (projectOverride?.slots) {
			for (const mode of Object.keys(projectOverride.slots)) {
				if (cfg.slots[mode as FrontendModel]) {
					cfg.slots[mode as FrontendModel] = mergeSlotOverrides(cfg.slots[mode as FrontendModel], projectOverride.slots[mode as FrontendModel]);
				}
			}
		}
	}
	return cfg;
}

/**
 * Resolve a frontend model ID to a concrete backend model.
 * Unknown frontend models fall through to the free slot.
 */
function resolveRoute(frontendId: string, ctx?: ExtensionContext): ResolvedRoute {
	// Unknown frontend IDs default to the free slot (graceful fallback)
	const resolvedId = config.slots[frontendId as FrontendModel] ? frontendId : "free";
	const slots = config.slots[resolvedId as FrontendModel];
	const target = slots.worker;
	const concrete = ctx?.modelRegistry?.find(target.provider, target.model);
	const valid = Boolean(concrete);
	return {
		frontend: `phenix/${frontendId}` as const,
		target,
		valid,
		validationMessage: valid ? undefined : `target model not found in Pi registry: ${target.provider}/${target.model}`,
	};
}

function persist(customType: string, data: unknown): void {
	try {
		piRef?.appendEntry(customType, data);
	} catch {
		// appendEntry is best-effort state evidence; command behavior does not depend on it.
	}
}

function renderRoute(route: ResolvedRoute): string {
	const status = route.valid ? "valid" : `invalid (${route.validationMessage})`;
	return `${route.frontend} -> ${route.target.provider}/${route.target.model} [${status}; routing:${route.frontend.replace("phenix/", "")}]`;
}

/** Render the full routing matrix result for display */
function renderMatrixResult(matrix: RoutingResult): string {
	const lines: string[] = [];
	const roleList = Object.entries(matrix.roles)
		.filter(([, active]) => active)
		.map(([role]) => role);
	lines.push(`${matrix.modelRef} | roles: ${roleList.join(", ") || "none"}`);
	if (matrix.warnings.length > 0) {
		lines.push(`warnings: ${matrix.warnings.join("; ")}`);
	}
	return lines.join("\n");
}

function routerStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			timestamp: Date.now(),
		};
		const ctx = activeContext;
		const route = resolveRoute(model.id, ctx);
		persist("phenix-router-route", route);

		try {
			if (!ctx) throw new Error("phenix-router has no active Pi extension context for model dispatch");
			if (!route.valid) throw new Error(route.validationMessage ?? `invalid route: ${renderRoute(route)}`);
			const concrete = ctx.modelRegistry.find(route.target.provider, route.target.model);
			if (!concrete) throw new Error(`target model not found in Pi registry: ${route.target.provider}/${route.target.model}`);

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(concrete);
			if (!auth.ok) throw new Error(auth.error);

			const upstream = streamSimple(concrete, context, {
				...options,
				apiKey: auth.apiKey,
				headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
				env: auth.env || options?.env ? { ...auth.env, ...options?.env } : undefined,
			});
			for await (const event of upstream) stream.push(event);
			stream.end(await upstream.result());
		} catch (error) {
			output.errorMessage = error instanceof Error ? error.message : String(error);
			calculateCost(model, output.usage);
			stream.push({ type: "start", partial: output });
			stream.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: output });
			stream.end();
		}
	})();
	return stream;
}

function registerPhenixProvider(pi: ExtensionAPI): void {
	pi.registerProvider(PHENIX_PROVIDER, {
		name: "Phenix Router",
		baseUrl: "https://phenix.local/router",
		apiKey: "phenix-router-local",
		api: ROUTER_API,
		streamSimple: routerStream,
		models: FRONTEND_MODELS.map((id) => ({
			id,
			name: `Phenix ${id}`,
			api: ROUTER_API,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		})),
	});
}

function handleRouterCommand(args: string, ctx: ExtensionContext): void {
	const [sub = "status", value] = args.trim().split(/\s+/, 2);
	if (sub === "status") {
		const currentModel = ctx.model?.id ?? "unknown";
		const route = resolveRoute(currentModel, ctx);
		const prompt = ctx.sessionManager?.getEntries()
			?.reverse()
			?.find((e) => e.type === "user")?.content ?? "";
		const matrix = classifyAndRoute(prompt, currentModel);
		const lines = [
			`enabled: ${config.enabled}`,
			`model: phenix/${currentModel}`,
			`route: ${renderRoute(route)}`,
			`matrix: ${renderMatrixResult(matrix)}`,
		];
		ctx.ui.notify(lines.join("\n"), route.valid ? "info" : "warning");
	} else if (sub === "routes") {
		const lines = FRONTEND_MODELS.map((m) => {
			const slots = config.slots[m];
			return `  phenix/${m} -> ${slots.worker.provider}/${slots.worker.model}`;
		});
		ctx.ui.notify(`Available routes:\n${lines.join("\n")}`, "info");
	} else if (sub === "explain") {
		const modelId = value && FRONTEND_MODELS.includes(value as FrontendModel) ? value : (ctx.model?.id ?? "free");
		const route = resolveRoute(modelId, ctx);
		const matrix = classifyAndRoute(value ?? "", modelId);
		const lines = [
			renderRoute(route),
			`matrix: ${renderMatrixResult(matrix)}`,
		];
		ctx.ui.notify(lines.join("\n"), route.valid ? "info" : "warning");
	} else if (sub === "reload") {
		config = loadConfig(ctx);
		ctx.ui.notify("phenix router config reloaded", "info");
	} else if (sub === "reset") {
		config = defaultConfig;
		persist("phenix-router-config", config);
		ctx.ui.notify("phenix router reset to defaults", "info");
	} else {
		ctx.ui.notify("usage: /router status|routes|explain|reload|reset", "warning");
	}
}

export default function phenixRouter(pi: ExtensionAPI) {
	piRef = pi;
	config = loadConfig();
	registerPhenixProvider(pi);

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		config = loadConfig(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		activeContext = ctx;
		if (!config.enabled) return;
		const modelId = ctx.model?.id ?? "free";
		const route = resolveRoute(modelId, ctx);
		const matrix = classifyAndRoute(event.prompt, modelId);
		persist("phenix-router-route", route);
		persist("phenix-routing-matrix", matrix);
		return {
			message: {
				customType: "phenix-router-route",
				content: `${renderRoute(route)}\n${renderMatrixResult(matrix)}`,
				display: true,
				details: { route, matrix },
			},
		};
	});

	pi.on("model_select", (event, ctx) => {
		activeContext = ctx;
	});

	pi.registerCommand("router", {
		description: "Inspect the Phenix provider-first model router",
		handler: async (args, ctx) => handleRouterCommand(args, ctx),
	});
}
