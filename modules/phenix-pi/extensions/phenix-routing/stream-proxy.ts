import type {
  Api,
  AssistantMessage,
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
import type { ResolvedRoute } from "./types.ts";

const PHENIX_PROVIDER = "phenix";
const PHENIX_MODEL = "workflow";
const PHENIX_API = "phenix-router";

const MASKED_EVENT_TYPES = new Set([
  "start",
  "text_start",
  "text_delta",
  "text_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
]);

function maskMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    api: PHENIX_API as Api,
    provider: PHENIX_PROVIDER,
    model: PHENIX_MODEL,
  };
}

/** Route a virtual Phenix model request to the selected concrete model. */
export function routerStream(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void runRouter(stream, model, context, options).catch((error) => {
    const errorMessage: AssistantMessage = {
      role: "assistant",
      content: [],
      api: PHENIX_API as Api,
      provider: PHENIX_PROVIDER,
      model: PHENIX_MODEL,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    stream.push({
      type: "error",
      reason: "error",
      error: maskMessage(errorMessage),
    });
    stream.end();
  });

  return stream;
}

async function runRouter(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<void> {
  let route = getActiveRouteForSession(options?.sessionId ?? "default");

  if (!route) {
    const sessionId = options?.sessionId ?? "default";
    const runtime = getSessionRuntime(sessionId);
    const modelSet =
      model.provider === PHENIX_PROVIDER
        ? (modelSetForModelId(model.id) ?? runtime.modelSet)
        : runtime.modelSet;

    route = await resolveRoute({
      modelSet,
      role: "coordinator",
      modelRegistry,
      config: loadRoutingConfig(),
    });
    setActiveRouteForSession(sessionId, route);
  }

  const concreteModel: Model<Api> | undefined = modelRegistry.getModel(
    route.model.provider,
    route.model.model,
  );
  if (!concreteModel) {
    throw new Error(
      `Model is not registered in Pi: ${route.model.provider}/${route.model.model}`,
    );
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(concreteModel);
  if (!auth.ok) {
    throw new Error(
      `Authentication unavailable for ${concreteModel.provider}/${concreteModel.id}: ${auth.error}`,
    );
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

  const upstreamStream = streamSimple(concreteModel, context, upstreamOptions);
  let substantiveOutputSeen = false;

  for await (const event of upstreamStream) {
    if (
      event.type === "text_delta" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_delta" ||
      event.type === "toolcall_end" ||
      event.type === "done"
    ) {
      substantiveOutputSeen = true;
    }

    if (event.type === "error") {
      stream.push({ ...event, error: maskMessage(event.error) });
      stream.end();
      return;
    }

    if (event.type === "done") {
      stream.push({ ...event, message: maskMessage(event.message) });
      stream.end();
      return;
    }

    if (MASKED_EVENT_TYPES.has(event.type)) {
      stream.push({
        ...event,
        partial: maskMessage(event.partial as AssistantMessage),
      } as typeof event);
    } else {
      stream.push(event);
    }
  }

  // Keep the variable explicit: fallback is permitted only before output.
  void substantiveOutputSeen;
  stream.end();
}

const activeRoutes = new Map<string, ResolvedRoute>();

export function setActiveRouteForSession(
  sessionId: string,
  route: ResolvedRoute,
): void {
  activeRoutes.set(sessionId, route);
}

export function getActiveRouteForSession(
  sessionId: string,
): ResolvedRoute | undefined {
  return activeRoutes.get(sessionId);
}

export function clearActiveRouteForSession(sessionId: string): void {
  activeRoutes.delete(sessionId);
}
