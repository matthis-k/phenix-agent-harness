import type { Api, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadRoutingConfig } from "./config.ts";
import {
  getActiveRouteForSession,
  type RouterStreamFunction,
  routerStream,
} from "./stream-proxy.ts";
import {
  createStreamTraceContext,
  runWithStreamTraceContext,
  streamTraceEnabled,
  streamTraceEventFields,
  writeStreamTrace,
} from "./stream-trace.ts";
import type { ModelSetId } from "./types.ts";

export const PHENIX_PROVIDER = "phenix";
export const PHENIX_API = "phenix-router";

/** Return the model sets exposed as virtual models by the active routing config. */
export function phenixModelSets(): readonly ModelSetId[] {
  return loadRoutingConfig().modelSetOrder;
}

/** Resolve a virtual Phenix model ID to its model-set declaration. */
export function modelSetForModelId(modelId: string): ModelSetId | undefined {
  return phenixModelSets().find((id) => modelId === id);
}

function routeTraceFields(sessionId: string): Record<string, unknown> {
  const route = getActiveRouteForSession(sessionId);
  if (!route) return { routeAvailable: false };

  return {
    routeAvailable: true,
    modelSet: route.modelSet,
    role: route.role,
    difficulty: route.difficulty,
    capability: route.capability,
    pool: route.pool,
    candidateCount: route.candidates.length,
    candidateIndex: route.candidateIndex,
    selectedProvider: route.model.provider,
    selectedModel: route.model.model,
    thinking: route.thinking,
  };
}

/**
 * Trace the virtual provider boundary without changing router semantics.
 *
 * The provider-created trace context is propagated synchronously into the
 * router, so its existing `pi_ingress` and `router_egress` records share the
 * same trace ID as provider and Pi message-assembly records.
 */
export function createTracedPhenixProviderStream(
  delegate: RouterStreamFunction = routerStream,
): RouterStreamFunction {
  return (model, context, options) => {
    if (!streamTraceEnabled()) return delegate(model, context, options);

    const sessionId = options?.sessionId ?? "default";
    const trace = createStreamTraceContext(sessionId);
    writeStreamTrace({
      boundary: "phenix_provider_request",
      traceId: trace.traceId,
      sessionId,
      virtualProvider: model.provider,
      virtualModel: model.id,
      contextMessageCount: context.messages.length,
      ...routeTraceFields(sessionId),
    });

    const output = createAssistantMessageEventStream();
    let source: ReturnType<RouterStreamFunction>;
    try {
      source = runWithStreamTraceContext(trace, () => delegate(model, context, options));
    } catch (error) {
      writeStreamTrace({
        boundary: "phenix_provider_failure",
        traceId: trace.traceId,
        sessionId,
        phase: "open",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    void (async () => {
      let providerSequence = 0;
      let terminalSeen = false;
      try {
        for await (const event of source) {
          providerSequence += 1;
          writeStreamTrace({
            boundary: "phenix_provider_egress",
            traceId: trace.traceId,
            sessionId,
            providerSequence,
            virtualProvider: model.provider,
            virtualModel: model.id,
            ...streamTraceEventFields(event),
          });
          output.push(event);

          if (event.type === "done" || event.type === "error") {
            terminalSeen = true;
            writeStreamTrace({
              boundary: "phenix_provider_terminal",
              traceId: trace.traceId,
              sessionId,
              providerSequence,
              ...streamTraceEventFields(event),
            });
          }
        }
      } catch (error) {
        writeStreamTrace({
          boundary: "phenix_provider_failure",
          traceId: trace.traceId,
          sessionId,
          phase: "forward",
          providerSequence,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        writeStreamTrace({
          boundary: "phenix_provider_stream_end",
          traceId: trace.traceId,
          sessionId,
          providerSequence,
          terminalSeen,
        });
        output.end();
      }
    })();

    return output;
  };
}

/**
 * Register the virtual routing provider.
 *
 * The provider itself performs no authentication. Pi currently requires every
 * registered provider to declare an authentication method, so the inert local
 * sentinel only satisfies that registration invariant and is never forwarded.
 * Concrete routed requests resolve credentials exclusively through Pi's model
 * registry for the selected upstream provider.
 */
export function registerPhenixProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PHENIX_PROVIDER, {
    name: "Phenix",
    baseUrl: "https://phenix.invalid/router",
    apiKey: "phenix-internal",
    authHeader: false,
    api: PHENIX_API as Api,
    models: phenixModelSets().map((setId) => ({
      id: setId,
      name: setId,
      api: PHENIX_API as Api,
      reasoning: true,
      input: ["text", "image"] satisfies Model<Api>["input"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 128000,
      maxTokens: 32768,
    })),
    streamSimple: createTracedPhenixProviderStream(),
  });
}
