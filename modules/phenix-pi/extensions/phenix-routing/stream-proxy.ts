import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

import { loadRoutingConfig } from "./config.ts";
import { modelSetForModelId } from "./provider.ts";
import { modelRegistry } from "./registry.ts";
import { resolveRoute } from "./resolver.ts";
import { getSessionRuntime } from "./state.ts";
import { formatModelRef, type ModelRef, type ResolvedRoute, type RoutingConfig } from "./types.ts";

const PHENIX_PROVIDER = "phenix";
const PHENIX_API = "phenix-router";

export type RouterStreamFunction = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Pi-owned upstream model and authentication boundary.
 *
 * Phenix chooses a concrete model, but Pi's registry remains the sole authority
 * for model discovery and credential/header/environment resolution.
 */
type PiUpstreamRuntime = Pick<
  typeof modelRegistry,
  "getApiKeyAndHeaders" | "getModel" | "isAvailable"
>;

type ErrorEvent = Extract<AssistantMessageEvent, { type: "error" }>;

export interface RouterStreamDependencies {
  readonly getSessionRuntime: typeof getSessionRuntime;
  readonly loadRoutingConfig: typeof loadRoutingConfig;
  readonly modelRegistry: PiUpstreamRuntime;
  readonly resolveRoute: typeof resolveRoute;
  readonly streamSimple: RouterStreamFunction;
}

const DEFAULT_DEPENDENCIES: RouterStreamDependencies = {
  getSessionRuntime,
  loadRoutingConfig,
  modelRegistry,
  resolveRoute,
  streamSimple,
};

function maskMessage(message: AssistantMessage, virtualModelId: string): AssistantMessage {
  return {
    ...message,
    api: PHENIX_API as Api,
    provider: PHENIX_PROVIDER,
    model: virtualModelId,
  };
}

function maskEvent(event: AssistantMessageEvent, virtualModelId: string): AssistantMessageEvent {
  if (event.type === "done") {
    return { ...event, message: maskMessage(event.message, virtualModelId) };
  }
  if (event.type === "error") {
    return { ...event, error: maskMessage(event.error, virtualModelId) };
  }
  return { ...event, partial: maskMessage(event.partial, virtualModelId) };
}

function isSubstantiveEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
    case "toolcall_end":
      return true;
    case "text_end":
    case "thinking_end":
      return event.content.length > 0;
    default:
      return false;
  }
}

function createTerminalError(provider: string, model: string, errorMessage: string): ErrorEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: PHENIX_API as Api,
      provider,
      model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage,
      timestamp: Date.now(),
    },
  };
}

function annotateExhaustedCandidates(
  event: ErrorEvent,
  attemptedModels: readonly ModelRef[],
): ErrorEvent {
  const attempted = attemptedModels.map(formatModelRef).join(", ");
  const lastError = event.error.errorMessage ?? "Unknown provider error";
  return {
    ...event,
    error: {
      ...event.error,
      errorMessage: `All routed models failed before producing output (${attempted}). Last error: ${lastError}`,
    },
  };
}

/** Build a routed stream function with injectable dependencies for deterministic tests. */
export function createRouterStream(
  overrides: Partial<RouterStreamDependencies> = {},
): RouterStreamFunction {
  const dependencies: RouterStreamDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    void runRouter(stream, model, context, options, dependencies).catch((error) => {
      stream.push(
        maskEvent(
          createTerminalError(
            PHENIX_PROVIDER,
            model.id,
            error instanceof Error ? error.message : String(error),
          ),
          model.id,
        ),
      );
      stream.end();
    });

    return stream;
  };
}

/** Route a virtual Phenix model request to the selected concrete model. */
export const routerStream = createRouterStream();

async function runRouter(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  dependencies: RouterStreamDependencies,
): Promise<void> {
  const sessionId = options?.sessionId ?? "default";
  const config = dependencies.loadRoutingConfig();
  const runtime = dependencies.getSessionRuntime(sessionId);
  const requestedModelSet =
    model.provider === PHENIX_PROVIDER
      ? (modelSetForModelId(model.id) ?? runtime.modelSet)
      : runtime.modelSet;
  const route = getActiveRouteForSession(sessionId);
  if (!route) {
    throw new Error(
      `Phenix workflow entry route is missing for session "${sessionId}". ` +
        "The before_agent_start workflow bootstrap must derive difficulty and install " +
        "the coordinator route before provider streaming begins.",
    );
  }
  if (route.modelSet !== requestedModelSet) {
    throw new Error(
      `Phenix workflow entry route targets model set "${route.modelSet}", ` +
        `but the selected virtual model requires "${requestedModelSet}".`,
    );
  }

  const virtualModelId = route.modelSet;
  const attemptedModels: ModelRef[] = [];

  while (true) {
    const attempt = await runRouteAttempt(
      stream,
      route,
      virtualModelId,
      context,
      options,
      dependencies,
    );

    if (attempt.type === "completed") {
      return;
    }

    attemptedModels.push(route.model);

    if (attempt.substantiveOutputSeen) {
      stream.push(maskEvent(attempt.event, virtualModelId));
      stream.end();
      return;
    }

    const fallback = await resolveFallbackRoute(route, attemptedModels, config, dependencies);

    if (!fallback) {
      clearActiveRouteForSession(sessionId);
      stream.push(
        maskEvent(annotateExhaustedCandidates(attempt.event, attemptedModels), virtualModelId),
      );
      stream.end();
      return;
    }

    route = fallback;
    setActiveRouteForSession(sessionId, route);
  }
}

type RouteAttemptResult =
  | { readonly type: "completed" }
  | {
      readonly type: "error";
      readonly event: ErrorEvent;
      readonly substantiveOutputSeen: boolean;
    };

async function runRouteAttempt(
  stream: AssistantMessageEventStream,
  route: ResolvedRoute,
  virtualModelId: string,
  context: Context,
  options: SimpleStreamOptions | undefined,
  dependencies: RouterStreamDependencies,
): Promise<RouteAttemptResult> {
  const concreteModel: Model<Api> | undefined = dependencies.modelRegistry.getModel(
    route.model.provider,
    route.model.model,
  );
  if (!concreteModel) {
    return {
      type: "error",
      event: createTerminalError(
        route.model.provider,
        route.model.model,
        `Model is not registered in Pi: ${formatModelRef(route.model)}`,
      ),
      substantiveOutputSeen: false,
    };
  }

  const auth = await dependencies.modelRegistry.getApiKeyAndHeaders(concreteModel);
  if (!auth.ok) {
    return {
      type: "error",
      event: createTerminalError(
        concreteModel.provider,
        concreteModel.id,
        `Authentication unavailable for ${concreteModel.provider}/${concreteModel.id}: ${auth.error}`,
      ),
      substantiveOutputSeen: false,
    };
  }

  const reasoning = route.thinking === "minimal" ? undefined : route.thinking;
  const {
    apiKey: _virtualApiKey,
    headers: virtualHeaders,
    env: virtualEnv,
    ...requestOptions
  } = options ?? {};
  const upstreamOptions: SimpleStreamOptions = {
    ...requestOptions,
    ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
    headers: { ...virtualHeaders, ...auth.headers },
    env: { ...virtualEnv, ...auth.env },
    reasoning,
  };

  const upstreamStream = dependencies.streamSimple(concreteModel, context, upstreamOptions);
  const pendingEvents: AssistantMessageEvent[] = [];
  let substantiveOutputSeen = false;

  for await (const event of upstreamStream) {
    if (event.type === "error") {
      return {
        type: "error",
        event,
        substantiveOutputSeen,
      };
    }

    if (event.type === "done") {
      for (const pending of pendingEvents) {
        stream.push(pending);
      }
      stream.push(maskEvent(event, virtualModelId));
      stream.end();
      return { type: "completed" };
    }

    const masked = maskEvent(event, virtualModelId);
    if (!substantiveOutputSeen && isSubstantiveEvent(event)) {
      substantiveOutputSeen = true;
      for (const pending of pendingEvents) {
        stream.push(pending);
      }
      pendingEvents.length = 0;
    }

    if (substantiveOutputSeen) {
      stream.push(masked);
    } else {
      pendingEvents.push(masked);
    }
  }

  return {
    type: "error",
    event: createTerminalError(
      concreteModel.provider,
      concreteModel.id,
      `Provider stream ended without a terminal event for ${concreteModel.provider}/${concreteModel.id}`,
    ),
    substantiveOutputSeen,
  };
}

async function resolveFallbackRoute(
  currentRoute: ResolvedRoute,
  attemptedModels: readonly ModelRef[],
  config: RoutingConfig,
  dependencies: RouterStreamDependencies,
): Promise<ResolvedRoute | undefined> {
  try {
    const next = await dependencies.resolveRoute({
      modelSet: currentRoute.modelSet,
      role: currentRoute.role,
      difficulty: currentRoute.difficulty,
      modelRegistry: dependencies.modelRegistry,
      config,
      avoidModels: attemptedModels,
    });

    const repeated = attemptedModels.some(
      (model) => formatModelRef(model) === formatModelRef(next.model),
    );
    if (next.usedAvoidedModelFallback || repeated) {
      return undefined;
    }

    return next;
  } catch {
    return undefined;
  }
}

const activeRoutes = new Map<string, ResolvedRoute>();

export function setActiveRouteForSession(sessionId: string, route: ResolvedRoute): void {
  activeRoutes.set(sessionId, route);
}

export function getActiveRouteForSession(sessionId: string): ResolvedRoute | undefined {
  return activeRoutes.get(sessionId);
}

export function clearActiveRouteForSession(sessionId: string): void {
  activeRoutes.delete(sessionId);
}
