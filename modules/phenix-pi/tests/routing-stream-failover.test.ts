import assert from "node:assert/strict";
import test from "node:test";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { modelSetId } from "../extensions/phenix-kernel/ids.ts";
import {
  clearActiveRouteForSession,
  createRouterStream,
  setActiveRouteForSession,
  type RouterStreamDependencies,
  type RouterStreamFunction,
} from "../extensions/phenix-routing/stream-proxy.ts";
import type { ModelRef, ResolvedRoute, RoutingConfig } from "../extensions/phenix-routing/types.ts";

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

function message(
  model: Model<Api>,
  stopReason: AssistantMessage["stopReason"],
  text = "",
  errorMessage?: string,
): AssistantMessage {
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
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function eventStream(events: readonly AssistantMessageEvent[]): ReturnType<RouterStreamFunction> {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  stream.end();
  return stream;
}

function failure(model: Model<Api>, errorMessage: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: message(model, "stop") },
    { type: "error", reason: "error", error: message(model, "error", "", errorMessage) },
  ];
}

function success(model: Model<Api>, text: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: message(model, "stop") },
    { type: "done", reason: "stop", message: message(model, "stop", text) },
  ];
}

function partialFailure(model: Model<Api>, errorMessage: string): AssistantMessageEvent[] {
  const partial = message(model, "stop", "partial");
  return [
    { type: "start", partial: message(model, "stop") },
    { type: "text_delta", contentIndex: 0, delta: "partial", partial },
    {
      type: "error",
      reason: "error",
      error: message(model, "error", "partial", errorMessage),
    },
  ];
}

function dependencies(
  candidates: readonly Model<Api>[],
  eventsFor: (model: Model<Api>) => AssistantMessageEvent[],
  attempts: string[],
): Partial<RouterStreamDependencies> {
  const refs: readonly ModelRef[] = candidates.map((model) => ({
    provider: model.provider,
    model: model.id,
  }));
  const models = new Map(candidates.map((model) => [`${model.provider}/${model.id}`, model]));

  const resolveRoute: RouterStreamDependencies["resolveRoute"] = async (input) => {
    const avoided = new Set(
      (input.avoidModels ?? []).map((model) => `${model.provider}/${model.model}`),
    );
    const nextIndex = refs.findIndex((model) => !avoided.has(`${model.provider}/${model.model}`));
    const index = nextIndex === -1 ? 0 : nextIndex;
    return {
      modelSet: modelSetId("free"),
      role: "coordinator",
      difficulty: "D1",
      capability: "general",
      pool: "free.universal",
      candidates: refs,
      model: refs[index],
      candidateIndex: index,
      thinking: "low",
      usedAvoidedModelFallback: nextIndex === -1,
    } satisfies ResolvedRoute;
  };

  const config = {
    defaultModelSet: modelSetId("free"),
    modelSetOrder: [modelSetId("free")],
    pools: { "free.universal": refs.map((model) => `${model.provider}/${model.model}`) },
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

  return {
    getSessionRuntime: (() => ({
      modelSet: modelSetId("free"),
    })) as RouterStreamDependencies["getSessionRuntime"],
    loadRoutingConfig: () => config,
    modelRegistry: {
      getModel(provider: string, model: string) {
        return models.get(`${provider}/${model}`);
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "pi-owned-test-key", headers: {}, env: {} };
      },
      async isAvailable() {
        return true;
      },
    } as RouterStreamDependencies["modelRegistry"],
    resolveRoute,
    streamSimple(model) {
      attempts.push(`${model.provider}/${model.id}`);
      return eventStream(eventsFor(model));
    },
  };
}

const virtualModel = makeModel("phenix", "free");
const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

async function collect(stream: ReturnType<RouterStreamFunction>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function assertVirtualIdentity(events: readonly AssistantMessageEvent[]): void {
  for (const event of events) {
    const publicMessage =
      event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
    assert.equal(publicMessage.provider, "phenix");
    assert.equal(publicMessage.model, "free");
  }
}

function primeEntryRoute(sessionId: string, candidates: readonly Model<Api>[]): void {
  const refs = candidates.map((model) => ({ provider: model.provider, model: model.id }));
  const first = refs[0];
  if (!first) throw new Error("Cannot prime an empty route");
  setActiveRouteForSession(sessionId, {
    modelSet: modelSetId("free"),
    role: "coordinator",
    difficulty: "D1",
    capability: "general",
    pool: "free.universal",
    candidates: refs,
    model: first,
    candidateIndex: 0,
    thinking: "low",
    usedAvoidedModelFallback: false,
  });
}

test("router retries before output while preserving phenix/free", async () => {
  const first = makeModel("opencode", "first-free");
  const second = makeModel("opencode", "second-free");
  const attempts: string[] = [];
  const sessionId = "routing-failover-success";
  clearActiveRouteForSession(sessionId);
  primeEntryRoute(sessionId, [first, second]);

  const events = await collect(
    createRouterStream(
      dependencies(
        [first, second],
        (model) =>
          model.id === first.id
            ? failure(model, "400 upstream failure")
            : success(model, "recovered"),
        attempts,
      ),
    )(virtualModel, context, { sessionId }),
  );

  assert.deepEqual(attempts, ["opencode/first-free", "opencode/second-free"]);
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assertVirtualIdentity(events);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "done");
  if (terminal?.type === "done") {
    assert.deepEqual(terminal.message.content, [{ type: "text", text: "recovered" }]);
  }
});

test("router does not fail over after public output starts", async () => {
  const first = makeModel("opencode", "partial-free");
  const second = makeModel("opencode", "unused-free");
  const attempts: string[] = [];
  const sessionId = "routing-failover-after-output";
  clearActiveRouteForSession(sessionId);

  const events = await collect(
    createRouterStream(
      dependencies(
        [first, second],
        (model) =>
          model.id === first.id
            ? partialFailure(model, "stream failed after output")
            : success(model, "must not run"),
        attempts,
      ),
    )(virtualModel, context, { sessionId }),
  );

  assert.deepEqual(attempts, ["opencode/partial-free"]);
  assertVirtualIdentity(events);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  if (terminal?.type === "error") {
    assert.equal(terminal.error.errorMessage, "stream failed after output");
  }
});

test("router reports internal attempts without leaking their identity", async () => {
  const candidates = [
    makeModel("opencode", "first-free"),
    makeModel("opencode", "second-free"),
    makeModel("opencode", "third-free"),
  ];
  const attempts: string[] = [];
  const sessionId = "routing-failover-exhausted";
  clearActiveRouteForSession(sessionId);
  primeEntryRoute(sessionId, candidates);

  const events = await collect(
    createRouterStream(
      dependencies(candidates, (model) => failure(model, `${model.id} failed`), attempts),
    )(virtualModel, context, { sessionId }),
  );

  assert.deepEqual(attempts, [
    "opencode/first-free",
    "opencode/second-free",
    "opencode/third-free",
  ]);
  assertVirtualIdentity(events);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  if (terminal?.type === "error") {
    assert.match(terminal.error.errorMessage ?? "", /opencode\/first-free/);
    assert.match(terminal.error.errorMessage ?? "", /opencode\/third-free/);
  }
});
