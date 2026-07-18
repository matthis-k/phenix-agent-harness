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
import {
  newStreamTraceId,
  streamTraceEnabled,
  streamTraceHash,
  streamTracePreview,
  streamTraceReasoningEnabled,
  writeStreamTrace,
} from "./stream-trace.ts";
import { formatModelRef, type ModelRef, type ResolvedRoute, type RoutingConfig } from "./types.ts";

const PHENIX_PROVIDER = "phenix";
const PHENIX_API = "phenix-router";
const REPETITION_COUNT = 4;
const REPETITION_MIN_SEGMENT_LENGTH = 32;
const REPETITION_MAX_SEGMENT_LENGTH = 512;

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

type RouterTrace = { readonly id: string; ingressSequence: number; egressSequence: number };

function eventTraceFields(event: AssistantMessageEvent): Record<string, unknown> {
  const partial =
    event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
  const contentIndex = "contentIndex" in event ? event.contentIndex : undefined;
  const block = contentIndex === undefined ? undefined : partial.content[contentIndex];
  const partialText =
    block?.type === "text" ? block.text : block?.type === "thinking" ? block.thinking : undefined;
  const delta = "delta" in event && typeof event.delta === "string" ? event.delta : undefined;
  const exposePreview = event.type !== "thinking_delta" || streamTraceReasoningEnabled();
  return {
    eventType: event.type,
    ...(contentIndex === undefined ? {} : { contentIndex }),
    ...(delta === undefined
      ? {}
      : {
          deltaLength: delta.length,
          deltaSha256: streamTraceHash(delta),
          ...(exposePreview ? { deltaPreview: streamTracePreview(delta) } : {}),
        }),
    ...(partialText === undefined
      ? {}
      : {
          partialBlockLength: partialText.length,
          partialBlockSha256: streamTraceHash(partialText),
        }),
    ...(event.type === "done" || event.type === "error"
      ? { stopReason: event.type === "done" ? event.message.stopReason : event.error.stopReason }
      : {}),
  };
}

function pushRouterEvent(
  stream: AssistantMessageEventStream,
  event: AssistantMessageEvent,
  trace: RouterTrace,
  routeAttempt: number,
  provider: string,
  concreteModel: string,
  ingressSequence?: number,
): void {
  if (streamTraceEnabled()) {
    trace.egressSequence += 1;
    writeStreamTrace({
      boundary: "router_egress",
      traceId: trace.id,
      routeAttempt,
      egressSequence: trace.egressSequence,
      ...(ingressSequence === undefined ? {} : { ingressSequence }),
      provider,
      concreteModel,
      ...eventTraceFields(event),
    });
  }
  stream.push(event);
}

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

function repeatedSuffix(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ");
  const maxSegmentLength = Math.min(
    REPETITION_MAX_SEGMENT_LENGTH,
    Math.floor(normalized.length / REPETITION_COUNT),
  );

  for (
    let segmentLength = maxSegmentLength;
    segmentLength >= REPETITION_MIN_SEGMENT_LENGTH;
    segmentLength -= 1
  ) {
    const segment = normalized.slice(-segmentLength);
    if (segment.trim().length < REPETITION_MIN_SEGMENT_LENGTH) continue;
    if (normalized.endsWith(segment.repeat(REPETITION_COUNT))) return segment.trim();
  }

  return undefined;
}

function repeatedOutputSegment(event: AssistantMessageEvent): string | undefined {
  if (event.type === "text_delta") {
    const block = event.partial.content[event.contentIndex];
    return block?.type === "text" ? repeatedSuffix(block.text) : undefined;
  }

  if (event.type === "thinking_delta") {
    const block = event.partial.content[event.contentIndex];
    return block?.type === "thinking" ? repeatedSuffix(block.thinking) : undefined;
  }

  return undefined;
}

function repeatedOutputError(segment: string): string {
  const preview = segment.length > 120 ? `${segment.slice(0, 117)}...` : segment;
  return (
    `Provider stream stopped after detecting ${REPETITION_COUNT} consecutive copies ` +
    `of substantial output: ${JSON.stringify(preview)}`
  );
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

    const trace: RouterTrace = {
      id: streamTraceEnabled() ? newStreamTraceId() : "",
      ingressSequence: 0,
      egressSequence: 0,
    };
    void runRouter(stream, model, context, options, dependencies, trace).catch((error) => {
      pushRouterEvent(
        stream,
        maskEvent(
          createTerminalError(
            PHENIX_PROVIDER,
            model.id,
            error instanceof Error ? error.message : String(error),
          ),
          model.id,
        ),
        trace,
        0,
        PHENIX_PROVIDER,
        model.id,
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
  trace: RouterTrace,
): Promise<void> {
  const sessionId = options?.sessionId ?? "default";
  const config = dependencies.loadRoutingConfig();
  const runtime = dependencies.getSessionRuntime(sessionId);
  const requestedModelSet =
    model.provider === PHENIX_PROVIDER
      ? (modelSetForModelId(model.id) ?? runtime.modelSet)
      : runtime.modelSet;
  let route = getActiveRouteForSession(sessionId);
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
  let routeAttempt = 0;

  while (true) {
    routeAttempt += 1;
    const attempt = await runRouteAttempt(
      stream,
      route,
      virtualModelId,
      context,
      options,
      dependencies,
      trace,
      routeAttempt,
    );

    if (attempt.type === "completed") {
      return;
    }

    attemptedModels.push(route.model);

    if (attempt.substantiveOutputSeen) {
      pushRouterEvent(
        stream,
        maskEvent(attempt.event, virtualModelId),
        trace,
        routeAttempt,
        route.model.provider,
        route.model.model,
        attempt.ingressSequence,
      );
      stream.end();
      return;
    }

    const fallback = await resolveFallbackRoute(route, attemptedModels, config, dependencies);

    if (!fallback) {
      clearActiveRouteForSession(sessionId);
      pushRouterEvent(
        stream,
        maskEvent(annotateExhaustedCandidates(attempt.event, attemptedModels), virtualModelId),
        trace,
        routeAttempt,
        route.model.provider,
        route.model.model,
        attempt.ingressSequence,
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
      readonly ingressSequence?: number;
    };

async function runRouteAttempt(
  stream: AssistantMessageEventStream,
  route: ResolvedRoute,
  virtualModelId: string,
  context: Context,
  options: SimpleStreamOptions | undefined,
  dependencies: RouterStreamDependencies,
  trace: RouterTrace,
  routeAttempt: number,
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
  const repetitionAbortController = new AbortController();
  const upstreamSignal = options?.signal
    ? AbortSignal.any([options.signal, repetitionAbortController.signal])
    : repetitionAbortController.signal;
  const upstreamOptions: SimpleStreamOptions = {
    ...requestOptions,
    ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
    headers: {
      ...virtualHeaders,
      ...auth.headers,
      ...(streamTraceEnabled()
        ? { "x-phenix-trace-id": trace.id, "x-phenix-route-attempt": String(routeAttempt) }
        : {}),
    },
    env: { ...virtualEnv, ...auth.env },
    reasoning,
    signal: upstreamSignal,
  };

  const upstreamStream = dependencies.streamSimple(concreteModel, context, upstreamOptions);
  const pendingEvents: Array<{ event: AssistantMessageEvent; ingressSequence: number }> = [];
  let substantiveOutputSeen = false;

  for await (const event of upstreamStream) {
    trace.ingressSequence += 1;
    const ingressSequence = trace.ingressSequence;
    if (streamTraceEnabled()) {
      writeStreamTrace({
        boundary: "pi_ingress",
        traceId: trace.id,
        routeAttempt,
        ingressSequence,
        provider: concreteModel.provider,
        concreteModel: concreteModel.id,
        ...eventTraceFields(event),
      });
    }
    if (event.type === "error") {
      return {
        type: "error",
        event,
        substantiveOutputSeen,
        ingressSequence,
      };
    }

    if (event.type === "done") {
      for (const pending of pendingEvents)
        pushRouterEvent(
          stream,
          pending.event,
          trace,
          routeAttempt,
          concreteModel.provider,
          concreteModel.id,
          pending.ingressSequence,
        );
      pushRouterEvent(
        stream,
        maskEvent(event, virtualModelId),
        trace,
        routeAttempt,
        concreteModel.provider,
        concreteModel.id,
        ingressSequence,
      );
      stream.end();
      return { type: "completed" };
    }

    const repeatedSegment = repeatedOutputSegment(event);
    if (repeatedSegment) {
      const errorMessage = repeatedOutputError(repeatedSegment);
      repetitionAbortController.abort(errorMessage);
      return {
        type: "error",
        event: createTerminalError(concreteModel.provider, concreteModel.id, errorMessage),
        substantiveOutputSeen: true,
        ingressSequence,
      };
    }

    const masked = maskEvent(event, virtualModelId);
    if (!substantiveOutputSeen && isSubstantiveEvent(event)) {
      substantiveOutputSeen = true;
      for (const pending of pendingEvents)
        pushRouterEvent(
          stream,
          pending.event,
          trace,
          routeAttempt,
          concreteModel.provider,
          concreteModel.id,
          pending.ingressSequence,
        );
      pendingEvents.length = 0;
    }

    if (substantiveOutputSeen) {
      pushRouterEvent(
        stream,
        masked,
        trace,
        routeAttempt,
        concreteModel.provider,
        concreteModel.id,
        ingressSequence,
      );
    } else {
      pendingEvents.push({ event: masked, ingressSequence });
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
