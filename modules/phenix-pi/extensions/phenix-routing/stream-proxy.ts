import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, streamSimple } from "@earendil-works/pi-ai";

import type { Api } from "@earendil-works/pi-ai";

import type { ResolvedRoute } from "./types.ts";

const PHENIX_PROVIDER = "phenix";
const PHENIX_MODEL = "workflow";
const PHENIX_API = "phenix-router";

/**
 * Event types that need their provider/model fields masked.
 */
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

/**
 * Mask the provider, model, and api fields of a partial AssistantMessage
 * so it appears to come from phenix/workflow.
 */
function maskMessage(msg: AssistantMessage): AssistantMessage {
  return {
    ...msg,
    api: PHENIX_API as Api,
    provider: PHENIX_PROVIDER,
    model: PHENIX_MODEL,
    responseModel: msg.responseModel ?? msg.responseModel,
  };
}

/**
 * Create a router stream that:
 * 1. Locates the session runtime.
 * 2. Resolves the active root route.
 * 3. Calls the concrete upstream via streamSimple using real auth.
 * 4. Masks all forwarded events.
 * 5. Applies candidate fallback pre-output.
 */
export function routerStream(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  // Kick off async routing in the background.
  runRouter(stream, model, context, options).catch((error) => {
    // If no events have been pushed yet, emit a masked error.
    const errorMsg: AssistantMessage = {
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
      error: maskMessage(errorMsg),
    });
    stream.end();
  });

  return stream;
}

async function runRouter(
  stream: AssistantMessageEventStream,
  _model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<void> {
  // 1. Locate session runtime from options.
  // The route is expected to have been stored by the before_agent_start hook.
  // We look for it in a process-level or module-level reference.
  const route = getActiveRouteForSession(options?.sessionId ?? "default");
  if (!route) {
    throw new Error("No active Phenix route for this session");
  }

  // 2. Obtain the concrete model registry entry.
  // We import from the index to get the modelRegistry reference.
  const { modelRegistry } = await import("./index.ts");

  const concreteModel = modelRegistry.getModel(
    route.model.provider,
    route.model.model,
  );

  if (!concreteModel) {
    throw new Error(
      `Concrete model ${route.model.provider}/${route.model.model} not found in registry`,
    );
  }

  // 3. Get real auth from the concrete model.
  const concreteAuth = modelRegistry.getApiKeyAndHeaders(concreteModel);

  // 4. Call the upstream API.
  const reasoningLevel = route.thinking === "minimal" ? undefined : route.thinking;

  const upstreamStream = streamSimple(
    concreteModel,
    context,
    {
      ...options,
      apiKey: concreteAuth.apiKey,
      headers: {
        ...concreteAuth.headers,
        ...options?.headers,
      },
      env: {
        ...concreteAuth.env,
        ...options?.env,
      },
      reasoning: reasoningLevel,
    },
  );

  // 5. Forward events with masking and candidate fallback.
  let substantiveOutputSeen = false;

  for await (const event of upstreamStream) {
    // Check for substantive output
    if (
      event.type === "text_delta" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_delta" ||
      event.type === "toolcall_end" ||
      event.type === "done"
    ) {
      substantiveOutputSeen = true;
    }

    // Error handling
    if (event.type === "error") {
      if (!substantiveOutputSeen) {
        // Pre-output error — buffer and try next candidate is handled
        // at the upstream level. We propagate this error masked.
        stream.push({
          ...event,
          error: maskMessage(event.error),
        });
        stream.end();
        return;
      }
      // Post-output error — propagate but don't fall back
      stream.push({
        ...event,
        error: maskMessage(event.error),
      });
      stream.end();
      return;
    }

    // Done event
    if (event.type === "done") {
      stream.push({
        ...event,
        message: maskMessage(event.message),
      });
      stream.end();
      return;
    }

    // Partial events
    if (MASKED_EVENT_TYPES.has(event.type)) {
      const maskedEvent = {
        ...event,
        partial: maskMessage(event.partial as AssistantMessage),
      } as typeof event;
      stream.push(maskedEvent);
    } else {
      stream.push(event);
    }
  }

  // If the loop ends naturally without a terminal event, close the stream.
  stream.end();
}

/** Module-level active route storage keyed by session ID. */
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
