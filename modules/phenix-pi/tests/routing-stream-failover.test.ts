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
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as Model<Api>;
}

function makeAssistantMessage(
  provider: string,
  model: string,
  stopReason: AssistantMessage["stopReason"],
  text = "",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions" as Api,
    provider,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function eventStream(events: readonly AssistantMessageEvent[]): ReturnType<RouterStreamFunction> {
  const stream = createAssistantMessageEventStream();
  for (const event of events) {
    stream.push(event);
  }
  stream.end();
  return stream;
}

function failureEvents(model: Model<Api>, message: string): AssistantMessageEvent[] {
  return [
    {
      type: "start",
      partial: makeAssistantMessage(model.provider, model.id, "stop"),
    },
    {
      type: "error",
      reason: "error",
      error: makeAssistantMessage(model.provider, model.id, "error", "", message),
    },
  ];
}

function successEvents(model: Model<Api>, text: string): AssistantMessageEvent[] {
  return [
    {
      type: "start",
      partial: makeAssistantMessage(model.provider, model.id, "stop"),
    },
    {
      type: "done",
      reason: "stop",
      message: makeAssistantMessage(model.provider, model.id, "stop", text),
    },
  ];
}

function partialFailureEvents(model: Model<Api>, message: string): AssistantMessageEvent[] {
  const partial = makeAssistantMessage(model.provider, model.id, "stop", "partial");
  return [
    {
      type: "start",
      partial: makeAssistantMessage(model.provider, model.id, "stop"),
    },
    {
      type: "text_delta",
      contentIndex: 0,
      delta: "partial",
      partial,
    },
    {
      type: "error",
      reason: "error",
      error: makeAssistantMessage(model.provider, model.id, "error", "partial", message),
    },
  ];
}

function buildDependencies(
  candidates: readonly Model<Api>[],
  streamForModel: (model: Model<Api>) => AssistantMessageEvent[],
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
    const candidateIndex = refs.findIndex(
      (model) => !avoided.has(`${model.provider}/${model.model}`),
    );
    const index = candidateIndex === -1 ? 0 : candidateIndex;

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
      usedAvoidedModelFallback: candidateIndex === -1,
    } satisfies ResolvedRoute;
  };

  const streamSimple: RouterStreamFunction = (model) => {
    attempts.push(`${model.provider}/${model.id}`);
    return eventStream(streamForModel(model));
  };

  const config = {
    defaultModelSet: modelSetId("free"),
    modelSetOrder: [modelSetId("free")],
    pools: { "free.universal": refs.map((model) => `${model.provider}/${model.model}`) },
    modelSets: {
      free: {
        fast: "free.universal",
        general: "free.universal",
        reasoning: "free.universal",
        "reasoning-max": "free.universal",
        "code-fast": "free.universal",
        code: "free.universal",
        "code-max": "free.universal",
        review: "free.universal",
        "review-max": "free.universal",
      },
    },
  } satisfies RoutingConfig;

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
        return { ok: true, apiKey: "test-key", headers: {}, env: {} };
      },
      async isAvailable() {
        return true;
      },
    } as RouterStreamDependencies["modelRegistry"],
    resolveRoute,
    streamSimple,
  };
}

const virtualModel = makeModel("phenix", "free");
const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

test("router retries the next candidate after a pre-output provider error", async () => {
  const first = makeModel("opencode", "first-free");
  const second = makeModel("opencode", "second-free");
  const attempts: string[] = [];
  const sessionId = "routing-failover-success";
  clearActiveRouteForSession(sessionId);

  const stream = createRouterStream(
    buildDependencies(
      [first, second],
      (model) =>
        model.id === first.id
          ? failureEvents(model, "400 upstream failure")
          : successEvents(model, "recovered"),
      attempts,
    ),
  )(virtualModel, context, { sessionId });

  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }

  assert.deepEqual(attempts, ["opencode/first-free", "opencode/second-free"]);
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "done");
  if (terminal?.type === "done") {
    assert.equal(terminal.message.provider, "phenix");
    assert.equal(terminal.message.model, "workflow");
    assert.deepEqual(terminal.message.content, [{ type: "text", text: "recovered" }]);
  }
});

test("router does not fail over after substantive output has started", async () => {
  const first = makeModel("opencode", "partial-free");
  const second = makeModel("opencode", "unused-free");
  const attempts: string[] = [];
  const sessionId = "routing-failover-after-output";
  clearActiveRouteForSession(sessionId);

  const stream = createRouterStream(
    buildDependencies(
      [first, second],
      (model) =>
        model.id === first.id
          ? partialFailureEvents(model, "stream failed after output")
          : successEvents(model, "must not run"),
      attempts,
    ),
  )(virtualModel, context, { sessionId });

  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }

  assert.deepEqual(attempts, ["opencode/partial-free"]);
  assert.equal(
    events.some((event) => event.type === "text_delta"),
    true,
  );
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  if (terminal?.type === "error") {
    assert.equal(terminal.error.errorMessage, "stream failed after output");
  }
});

test("router reports every attempted candidate when the pool is exhausted", async () => {
  const first = makeModel("opencode", "first-free");
  const second = makeModel("opencode", "second-free");
  const third = makeModel("opencode", "third-free");
  const attempts: string[] = [];
  const sessionId = "routing-failover-exhausted";
  clearActiveRouteForSession(sessionId);

  const stream = createRouterStream(
    buildDependencies(
      [first, second, third],
      (model) => failureEvents(model, `${model.id} failed`),
      attempts,
    ),
  )(virtualModel, context, { sessionId });

  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }

  assert.deepEqual(attempts, [
    "opencode/first-free",
    "opencode/second-free",
    "opencode/third-free",
  ]);
  assert.equal(events.filter((event) => event.type === "start").length, 0);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  if (terminal?.type === "error") {
    assert.match(
      terminal.error.errorMessage ?? "",
      /All routed models failed before producing output \(opencode\/first-free, opencode\/second-free, opencode\/third-free\)/,
    );
    assert.match(terminal.error.errorMessage ?? "", /third-free failed/);
  }
});
