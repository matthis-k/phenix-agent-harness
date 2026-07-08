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

type Difficulty = "D0" | "D1" | "D2" | "D3";
type Secrecy = "Public" | "Private" | "Secret";
type Mode = "auto" | "mixed" | "openai-plus" | "opencode-go" | "free";

interface ConcreteModelRef {
	provider: string;
	model: string;
}

interface RouteRule {
	match?: {
		difficulty?: Difficulty[];
		secrecy?: Secrecy[];
		changeKind?: string[];
		mainBound?: boolean;
	};
	target: keyof RouterConfig["targets"];
	reason: string;
}

interface RouterConfig {
	version: 1;
	enabled: boolean;
	mode: Mode;
	maxFollowUpRetries: number;
	targets: {
		mixed: ConcreteModelRef;
		openaiPlus: ConcreteModelRef;
		opencodeGo: ConcreteModelRef;
		free: ConcreteModelRef;
	};
	rules: RouteRule[];
}

interface RouterState {
	enabled: boolean;
	mode: Mode;
	retryCount: number;
	lastRoute?: ResolvedRoute;
	lastFailure?: FailureEvidence;
}

interface RouteInput {
	difficulty: Difficulty;
	secrecy: Secrecy;
	changeKind: string;
	mainBound: boolean;
}

interface ResolvedRoute {
	frontend: `phenix/${Mode}`;
	targetName: keyof RouterConfig["targets"];
	target: ConcreteModelRef;
	reason: string;
	valid: boolean;
	validationMessage?: string;
}

interface FailureEvidence {
	providerErrors: string[];
	toolErrors: string[];
	assistantErrors: string[];
	turnErrors: string[];
}

const PHENIX_PROVIDER = "phenix";
const ROUTER_API = "phenix-router-api" as Api;

const frontendModels = ["auto", "mixed", "openai-plus", "opencode-go", "free"] as const;

const defaultConfig: RouterConfig = {
	version: 1,
	enabled: true,
	mode: "auto",
	maxFollowUpRetries: 1,
	targets: {
		mixed: { provider: "opencode-go", model: "kimi-k2.7-code" },
		openaiPlus: { provider: "openai-codex", model: "gpt-5.2-codex" },
		opencodeGo: { provider: "opencode-go", model: "kimi-k2.7-code" },
		free: { provider: "opencode", model: "north-mini-code-free" },
	},
	rules: [
		{
			match: { secrecy: ["Private", "Secret"] },
			target: "openaiPlus",
			reason: "private_or_secret_work_avoids_free_public_models",
		},
		{
			match: { difficulty: ["D2", "D3"] },
			target: "openaiPlus",
			reason: "higher_difficulty_uses_stronger_plus_slot",
		},
		{
			match: { difficulty: ["D0", "D1"], secrecy: ["Public"] },
			target: "opencodeGo",
			reason: "bounded_public_work_uses_go_slot",
		},
	],
};

const emptyEvidence = (): FailureEvidence => ({ providerErrors: [], toolErrors: [], assistantErrors: [], turnErrors: [] });

let config: RouterConfig = defaultConfig;
let state: RouterState = { enabled: defaultConfig.enabled, mode: defaultConfig.mode, retryCount: 0 };
let evidence = emptyEvidence();

function readJson(path: string): Partial<RouterConfig> | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
}

function mergeConfig(base: RouterConfig, override: Partial<RouterConfig> | undefined): RouterConfig {
	if (!override) return base;
	return {
		...base,
		...override,
		targets: { ...base.targets, ...(override.targets ?? {}) },
		rules: override.rules ?? base.rules,
	};
}

function loadConfig(ctx?: ExtensionContext): RouterConfig {
	const globalPath = join(getAgentDir(), "extensions", "phenix-router.routes.json");
	const projectPath = ctx?.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "phenix-router.routes.json") : undefined;
	let next = mergeConfig(defaultConfig, readJson(globalPath));
	if (projectPath) next = mergeConfig(next, readJson(projectPath));
	return next;
}

function inferInput(prompt: string): RouteInput {
	const lower = prompt.toLowerCase();
	const difficulty: Difficulty = lower.includes("d3") ? "D3" : lower.includes("d2") ? "D2" : lower.includes("d0") ? "D0" : "D1";
	const secrecy: Secrecy = lower.includes("secret") ? "Secret" : lower.includes("private") ? "Private" : "Public";
	const mainBound = lower.includes("main-bound") || lower.includes("main_bound") || lower.includes("main branch");
	const changeKind = lower.includes("workflow") ? "Workflow" : lower.includes("nix") ? "Nix" : lower.includes("auth") ? "Auth" : "Unknown";
	return { difficulty, secrecy, changeKind, mainBound };
}

function matchesRule(rule: RouteRule, input: RouteInput): boolean {
	const m = rule.match;
	if (!m) return true;
	if (m.difficulty && !m.difficulty.includes(input.difficulty)) return false;
	if (m.secrecy && !m.secrecy.includes(input.secrecy)) return false;
	if (m.changeKind && !m.changeKind.includes(input.changeKind)) return false;
	if (typeof m.mainBound === "boolean" && m.mainBound !== input.mainBound) return false;
	return true;
}

function resolveRoute(mode: Mode, input: RouteInput, ctx?: ExtensionContext): ResolvedRoute {
	const targetName =
		mode === "openai-plus" ? "openaiPlus" : mode === "opencode-go" ? "opencodeGo" : mode === "free" ? "free" : mode === "mixed" ? "mixed" :
		(config.rules.find((rule) => matchesRule(rule, input))?.target ?? "mixed");
	const target = config.targets[targetName];
	const concrete = ctx?.modelRegistry.find(target.provider, target.model);
	const deniedFree = targetName === "free" && (input.secrecy !== "Public" || input.difficulty === "D2" || input.difficulty === "D3");
	return {
		frontend: `phenix/${mode}`,
		targetName,
		target,
		reason: deniedFree ? "free_route_denied_by_privacy_or_difficulty_guard" : config.rules.find((rule) => rule.target === targetName && matchesRule(rule, input))?.reason ?? "explicit_mode_selection",
		valid: Boolean(concrete) && !deniedFree,
		validationMessage: deniedFree ? "free target is denied for private/secret or D2/D3 work" : concrete ? undefined : `target model not found in Pi registry: ${target.provider}/${target.model}`,
	};
}

function persist(customType: string, data: unknown): void {
	try {
		piRef?.appendEntry(customType, data);
	} catch {
		// appendEntry is best-effort state evidence; command behavior does not depend on it.
	}
}

let piRef: ExtensionAPI | undefined;
let activeContext: ExtensionContext | undefined;

function renderRoute(route: ResolvedRoute): string {
	const status = route.valid ? "valid" : `invalid (${route.validationMessage})`;
	return `${route.frontend} -> ${route.target.provider}/${route.target.model} [${status}; ${route.reason}]`;
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
		const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
		const prompt = typeof lastUser?.content === "string" ? lastUser.content : "";
		const ctx = activeContext;
		const route = resolveRoute(model.id as Mode, inferInput(prompt), ctx);
		state.lastRoute = route;
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
				apiKey: options?.apiKey ?? auth.apiKey,
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
		// Local sentinel only: Pi requires an apiKey field for custom models, but
		// this provider never sends it to a remote service because streamSimple is
		// handled in-process below.
		apiKey: "phenix-router-local",
		api: ROUTER_API,
		streamSimple: routerStream,
		models: frontendModels.map((id) => ({
			id,
			name: `Phenix ${id}`,
			api: ROUTER_API,
			reasoning: id !== "free",
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		})),
	});
}

function showStatus(ctx: ExtensionContext): string {
	const lines = [
		`enabled: ${state.enabled}`,
		`mode: ${state.mode}`,
		`config: global ${join(getAgentDir(), "extensions", "phenix-router.routes.json")}; project ${join(ctx.cwd, CONFIG_DIR_NAME, "phenix-router.routes.json")}`,
	];
	if (state.lastRoute) lines.push(`last_route: ${renderRoute(state.lastRoute)}`);
	if (state.lastFailure) lines.push(`last_failure: ${JSON.stringify(state.lastFailure)}`);
	return lines.join("\n");
}

function handleRouterCommand(args: string, ctx: ExtensionContext): void {
	const [sub = "status", value] = args.trim().split(/\s+/, 2);
	if (sub === "status") ctx.ui.notify(showStatus(ctx), "info");
	else if (sub === "profile" || sub === "mode") {
		if (value && frontendModels.includes(value as Mode)) {
			state.mode = value as Mode;
			persist("phenix-router-state", state);
		}
		ctx.ui.notify(`phenix router mode: ${state.mode}`, "info");
	} else if (sub === "routes") {
		ctx.ui.notify(Object.entries(config.targets).map(([name, target]) => `${name}: ${target.provider}/${target.model}`).join("\n"), "info");
	} else if (sub === "explain") {
		const route = resolveRoute(state.mode, inferInput(value ?? ""), ctx);
		state.lastRoute = route;
		persist("phenix-router-route", route);
		ctx.ui.notify(renderRoute(route), route.valid ? "info" : "warning");
	} else if (sub === "reload") {
		config = loadConfig(ctx);
		ctx.ui.notify("phenix router config reloaded", "info");
	} else if (sub === "reset") {
		config = defaultConfig;
		state = { enabled: defaultConfig.enabled, mode: defaultConfig.mode, retryCount: 0 };
		persist("phenix-router-state", state);
		ctx.ui.notify("phenix router reset to defaults", "info");
	} else {
		ctx.ui.notify("usage: /router status|profile|mode|routes|explain|reload|reset", "warning");
	}
}

export default function phenixRouter(pi: ExtensionAPI) {
	piRef = pi;
	config = loadConfig();
	registerPhenixProvider(pi);

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		config = loadConfig(ctx);
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "phenix-router-state" && entry.data) {
				state = { ...state, ...(entry.data as Partial<RouterState>) };
			}
		}
		ctx.ui.setStatus("phenix-router", state.enabled ? `router:${state.mode}` : "router:off");
	});

	pi.on("before_agent_start", (event, ctx) => {
		activeContext = ctx;
		if (!state.enabled) return;
		const route = resolveRoute(state.mode, inferInput(event.prompt), ctx);
		state.lastRoute = route;
		state.retryCount = 0;
		evidence = emptyEvidence();
		persist("phenix-router-route", route);
		return { message: { customType: "phenix-router-route", content: renderRoute(route), display: true, details: route } };
	});

	pi.on("tool_result", (event) => {
		if (event.isError) evidence.toolErrors.push(`${event.toolName}: ${event.content.map((item) => item.type === "text" ? item.text : "[image]").join(" ")}`.slice(0, 500));
	});

	pi.on("after_provider_response", (event) => {
		if (event.status >= 400) evidence.providerErrors.push(`http ${event.status}: ${JSON.stringify(event.headers)}`.slice(0, 500));
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && event.message.stopReason === "error") evidence.assistantErrors.push(event.message.errorMessage ?? "assistant error");
	});

	pi.on("turn_end", (event) => {
		if (event.message.role === "assistant" && event.message.stopReason === "error") evidence.turnErrors.push(event.message.errorMessage ?? "turn error");
	});

	pi.on("agent_end", () => {
		const hasFailure = evidence.providerErrors.length + evidence.toolErrors.length + evidence.assistantErrors.length + evidence.turnErrors.length > 0;
		state.lastFailure = hasFailure ? evidence : undefined;
		persist("phenix-router-state", state);
		if (hasFailure && state.retryCount < config.maxFollowUpRetries) {
			state.retryCount += 1;
			pi.sendMessage({ customType: "phenix-router-retry", content: `Phenix router observed failure evidence and queued bounded follow-up retry ${state.retryCount}/${config.maxFollowUpRetries}.`, display: true, details: evidence }, { deliverAs: "followUp", triggerTurn: true });
		}
	});

	pi.on("model_select", (event, ctx) => {
		activeContext = ctx;
		ctx.ui.setStatus("phenix-router", event.model.provider === PHENIX_PROVIDER ? `router:${event.model.id}` : `router:${state.mode}`);
	});

	pi.registerCommand("router", {
		description: "Inspect or adjust the Phenix provider-first model router",
		handler: async (args, ctx) => handleRouterCommand(args, ctx),
	});
}
