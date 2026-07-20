import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { createTracedPhenixProviderStream } from "@matthis-k/phenix-routing/provider.ts";
import type { RouterStreamFunction } from "@matthis-k/phenix-routing/stream-proxy.ts";
import { newStreamTraceId } from "@matthis-k/phenix-routing/stream-trace.ts";

function model(provider: string, id: string): Model<Api> {
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

function message(activeModel: Model<Api>, text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
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

test("virtual provider and router share one trace id", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phenix-provider-trace-"));
  const tracePath = join(directory, "trace.jsonl");
  const previous = process.env.PHENIX_PI_STREAM_TRACE;
  process.env.PHENIX_PI_STREAM_TRACE = tracePath;

  try {
    const virtualModel = model("phenix", "free");
    const context: Context = {
      messages: [{ role: "user", content: "Inspect the repository.", timestamp: Date.now() }],
    };
    let routerTraceId: string | undefined;
    const delegate: RouterStreamFunction = (activeModel) => {
      routerTraceId = newStreamTraceId();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message(activeModel) });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "done",
        partial: message(activeModel, "done"),
      });
      stream.push({ type: "done", reason: "stop", message: message(activeModel, "done") });
      stream.end();
      return stream;
    };

    const events: AssistantMessageEvent[] = [];
    const traced = createTracedPhenixProviderStream(delegate)(virtualModel, context, {
      sessionId: "provider-trace-session",
    });
    for await (const event of traced) events.push(event);

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_delta", "done"],
    );

    const records = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const traceIds = new Set(records.map((record) => record.traceId));
    assert.deepEqual([...traceIds], [routerTraceId]);
    assert.equal(
      records.filter((record) => record.boundary === "phenix_provider_request").length,
      1,
    );
    assert.equal(
      records.filter((record) => record.boundary === "phenix_provider_egress").length,
      3,
    );
    assert.equal(
      records.filter((record) => record.boundary === "phenix_provider_terminal").length,
      1,
    );
    assert.equal(
      records.filter((record) => record.boundary === "phenix_provider_stream_end").length,
      1,
    );

    const delta = records.find(
      (record) => record.boundary === "phenix_provider_egress" && record.eventType === "text_delta",
    );
    assert.equal(delta?.deltaLength, 4);
    assert.equal(typeof delta?.deltaSha256, "string");

    const terminal = records.find((record) => record.boundary === "phenix_provider_terminal");
    assert.equal(terminal?.visibleTextLength, 4);
    assert.equal(typeof terminal?.visibleTextSha256, "string");
  } finally {
    if (previous === undefined) delete process.env.PHENIX_PI_STREAM_TRACE;
    else process.env.PHENIX_PI_STREAM_TRACE = previous;
    rmSync(directory, { recursive: true });
  }
});
