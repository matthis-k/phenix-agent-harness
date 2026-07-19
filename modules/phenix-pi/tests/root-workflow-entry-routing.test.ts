import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { clearSessionRuntime, getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import {
  clearActiveRouteForSession,
  createRouterStream,
  getActiveRouteForSession,
  type RouterStreamFunction,
} from "@matthis-k/phenix-routing/stream-proxy.ts";
import { prepareRootWorkflowEntry } from "@matthis-k/phenix-suite/composition/root-workflow-entry.ts";
import { buildDefaultRoutingConfig } from "./support/default-routing-fixture.ts";

function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "openai-completions" as Api,
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
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

function successStream(model: Model<Api>, text: string): ReturnType<RouterStreamFunction> {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message(model, "stop") });
  stream.push({ type: "done", reason: "stop", message: message(model, "stop", text) });
  stream.end();
  return stream;
}

async function collect(stream: ReturnType<RouterStreamFunction>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function clear(sessionId: string): void {
  clearActiveRouteForSession(sessionId);
  clearSessionRuntime(sessionId);
}

describe("root workflow entry routing", () => {
  it("mock-routes a fresh phenix/free turn before the first provider request", async () => {
    const sessionId = "fresh-root-workflow-entry";
    clear(sessionId);

    const concreteModel = makeModel("opencode", "deepseek-v4-flash-free");
    const registry = {
      getModel(provider: string, model: string) {
        return provider === concreteModel.provider && model === concreteModel.id
          ? concreteModel
          : undefined;
      },
      async isAvailable(provider: string, model: string) {
        return provider === concreteModel.provider && model === concreteModel.id;
      },
      async getApiKeyAndHeaders() {
        return { ok: true as const, apiKey: "pi-owned-key", headers: {}, env: {} };
      },
    };

    const entry = await prepareRootWorkflowEntry(
      {
        sessionId,
        selectedModel: { provider: "phenix", id: "free" },
        userMessage: "Investigate and redesign the authentication workflow root cause.",
        config: buildDefaultRoutingConfig(),
      },
      { modelRegistry: registry },
    );

    assert.equal(entry.difficulty, "D2");
    assert.equal(entry.route.modelSet, "free");
    assert.equal(entry.route.role, "coordinator");
    assert.equal(entry.route.capability, "reasoning");
    assert.equal(entry.route.thinking, "high");
    assert.deepEqual(entry.route.model, {
      provider: "opencode",
      model: "deepseek-v4-flash-free",
    });
    assert.equal(getSessionRuntime(sessionId).activeRoute, entry.route);
    assert.equal(getActiveRouteForSession(sessionId), entry.route);

    let routedModel: Model<Api> | undefined;
    let routedOptions: SimpleStreamOptions | undefined;
    let unexpectedInitialResolution = false;
    const stream = createRouterStream({
      modelRegistry: registry,
      async resolveRoute() {
        unexpectedInitialResolution = true;
        throw new Error("stream must consume the workflow entry route");
      },
      streamSimple(model, _context, options) {
        routedModel = model;
        routedOptions = options;
        return successStream(model, "routed");
      },
    });

    const events = await collect(stream(makeModel("phenix", "free"), context, { sessionId }));

    assert.equal(unexpectedInitialResolution, false);
    assert.equal(routedModel, concreteModel);
    assert.equal(routedOptions?.apiKey, "pi-owned-key");
    assert.equal(routedOptions?.reasoning, "high");
    for (const event of events) {
      const publicMessage =
        event.type === "done"
          ? event.message
          : event.type === "error"
            ? event.error
            : event.partial;
      assert.equal(publicMessage.provider, "phenix");
      assert.equal(publicMessage.model, "free");
    }

    clear(sessionId);
  });

  it("fails closed when streaming starts without a workflow entry route", async () => {
    const sessionId = "missing-root-workflow-entry";
    clear(sessionId);

    let routeResolutionCalled = false;
    let providerCalled = false;
    const stream = createRouterStream({
      modelRegistry: {
        getModel() {
          return undefined;
        },
        async isAvailable() {
          return false;
        },
        async getApiKeyAndHeaders() {
          return { ok: false as const, error: "unavailable" };
        },
      },
      async resolveRoute() {
        routeResolutionCalled = true;
        throw new Error("must not invent a route");
      },
      streamSimple() {
        providerCalled = true;
        throw new Error("provider must not be called");
      },
    });

    const events = await collect(stream(makeModel("phenix", "free"), context, { sessionId }));
    const terminal = events.at(-1);

    assert.equal(routeResolutionCalled, false);
    assert.equal(providerCalled, false);
    assert.equal(terminal?.type, "error");
    if (terminal?.type === "error") {
      assert.match(terminal.error.errorMessage ?? "", /workflow entry route.*missing/i);
      assert.equal(terminal.error.provider, "phenix");
      assert.equal(terminal.error.model, "free");
    }

    clear(sessionId);
  });
});
