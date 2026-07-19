import assert from "node:assert/strict";
import test from "node:test";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";
import {
  clearActiveRouteForSession,
  createRouterStream,
  type RouterStreamDependencies,
  type RouterStreamFunction,
  setActiveRouteForSession,
} from "@matthis-k/phenix-routing/stream-proxy.ts";
import type { ResolvedRoute, RoutingConfig } from "@matthis-k/phenix-routing/types.ts";

function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "openai-completions" as Api,
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as Model<Api>;
}

function message(model: Model<Api>, text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function textStream(
  model: Model<Api>,
  segment: string,
  repeatCount: number,
  tail = "",
): ReturnType<RouterStreamFunction> {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message(model) });

  let text = "";
  for (let index = 0; index < repeatCount; index += 1) {
    text += segment;
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: segment,
      partial: message(model, text),
    });
  }

  if (tail) {
    text += tail;
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: tail,
      partial: message(model, text),
    });
  }

  stream.push({ type: "done", reason: "stop", message: message(model, text) });
  stream.end();
  return stream;
}

function config(): RoutingConfig {
  return {
    defaultModelSet: modelSetId("free"),
    modelSetOrder: [modelSetId("free")],
    pools: { "free.universal": ["opencode/repetition-test"] },
    modelSets: {
      free: Object.fromEntries(
        [
          "fast",
          "general",
          "reasoning",
          "reasoning-max",
          "code-fast",
          "code",
          "code-max",
          "review",
          "review-max",
        ].map((capability) => [capability, "free.universal"]),
      ),
    },
  } as RoutingConfig;
}

function primeRoute(sessionId: string, concreteModel: Model<Api>): void {
  const model = { provider: concreteModel.provider, model: concreteModel.id };
  setActiveRouteForSession(sessionId, {
    modelSet: modelSetId("free"),
    role: "coordinator",
    difficulty: "D1",
    capability: "general",
    pool: "free.universal",
    candidates: [model],
    model,
    candidateIndex: 0,
    thinking: "low",
    usedAvoidedModelFallback: false,
  } satisfies ResolvedRoute);
}

function dependencies(
  concreteModel: Model<Api>,
  stream: ReturnType<RouterStreamFunction>,
  onOptions?: (options: SimpleStreamOptions | undefined) => void,
): Partial<RouterStreamDependencies> {
  return {
    getSessionRuntime: (() => ({
      modelSet: modelSetId("free"),
    })) as RouterStreamDependencies["getSessionRuntime"],
    loadRoutingConfig: config,
    modelRegistry: {
      getModel(provider: string, model: string) {
        return provider === concreteModel.provider && model === concreteModel.id
          ? concreteModel
          : undefined;
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "pi-owned-test-key", headers: {}, env: {} };
      },
      async isAvailable() {
        return true;
      },
    } as RouterStreamDependencies["modelRegistry"],
    async resolveRoute() {
      throw new Error("A stream with public output must not fail over");
    },
    streamSimple(_model, _context, options) {
      onOptions?.(options);
      return stream;
    },
  };
}

async function collect(stream: ReturnType<RouterStreamFunction>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const virtualModel = makeModel("phenix", "free");
const context: Context = {
  messages: [{ role: "user", content: "Inspect the extensions directory.", timestamp: Date.now() }],
};
const repeatedSegment = "Let me check if there's a pi-binary-fix in the extensions directory. ";

test("router stops and aborts a pathological repeated-output stream", async () => {
  const concreteModel = makeModel("opencode", "repetition-test");
  const sessionId = "routing-repetition-breaker";
  clearActiveRouteForSession(sessionId);
  primeRoute(sessionId, concreteModel);

  let upstreamSignal: AbortSignal | undefined;
  const upstream = textStream(concreteModel, repeatedSegment, 8);
  const events = await collect(
    createRouterStream(
      dependencies(concreteModel, upstream, (options) => {
        upstreamSignal = options?.signal;
      }),
    )(virtualModel, context, { sessionId }),
  );

  assert.equal(events.filter((event) => event.type === "text_delta").length, 3);
  assert.equal(
    events.some((event) => event.type === "done"),
    false,
  );
  assert.equal(upstreamSignal?.aborted, true);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  if (terminal?.type === "error") {
    assert.match(terminal.error.errorMessage ?? "", /four|4 consecutive copies/i);
    assert.match(terminal.error.errorMessage ?? "", /provider stream stopped/i);
    assert.equal(terminal.error.provider, "phenix");
    assert.equal(terminal.error.model, "free");
  }

  clearActiveRouteForSession(sessionId);
});

test("router permits limited intentional repetition", async () => {
  const concreteModel = makeModel("opencode", "limited-repetition-test");
  const sessionId = "routing-limited-repetition";
  clearActiveRouteForSession(sessionId);
  primeRoute(sessionId, concreteModel);

  const upstream = textStream(concreteModel, repeatedSegment, 3, "Inspection complete.");
  const events = await collect(
    createRouterStream(dependencies(concreteModel, upstream))(virtualModel, context, {
      sessionId,
    }),
  );

  assert.equal(events.filter((event) => event.type === "text_delta").length, 4);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "done");
  if (terminal?.type === "done") {
    assert.match(
      terminal.message.content[0]?.type === "text" ? terminal.message.content[0].text : "",
      /Inspection complete\.$/,
    );
  }

  clearActiveRouteForSession(sessionId);
});
