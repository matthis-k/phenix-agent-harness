import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerOpenCodeGoCompatibility, {
  requiresOpenCodeGoPayloadSanitization,
  sanitizeOpenCodeGoPayload,
} from "../extensions/phenix-integrations/opencode-go-compat.ts";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

describe("OpenCode Go payload compatibility", () => {
  it("removes optional wire fields without changing tool schemas", () => {
    const parameters = {
      type: "object",
      properties: {
        cache_control: { type: "string" },
        strict: { type: "boolean" },
      },
    };
    const payload = {
      model: "deepseek-v4-flash",
      prompt_cache_key: "session",
      prompt_cache_retention: "24h",
      store: false,
      stream_options: { include_usage: true },
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "system prompt",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "user",
          content: "hello",
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read", parameters, strict: false },
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    assert.deepEqual(sanitizeOpenCodeGoPayload(payload), {
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "system prompt" }],
        },
        {
          role: "user",
          content: "hello",
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read", parameters },
        },
      ],
    });
  });

  it("preserves payload identity when no incompatible fields are present", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    };

    assert.equal(sanitizeOpenCodeGoPayload(payload), payload);
  });

  it("sanitizes only OpenCode Go OpenAI-completions requests", () => {
    assert.equal(
      requiresOpenCodeGoPayloadSanitization({
        provider: "opencode-go",
        api: "openai-completions",
      }),
      true,
    );
    assert.equal(
      requiresOpenCodeGoPayloadSanitization({
        provider: "opencode-go",
        api: "anthropic-messages",
      }),
      false,
    );
    assert.equal(
      requiresOpenCodeGoPayloadSanitization({
        provider: "openai-codex",
        api: "openai-completions",
      }),
      false,
    );
  });

  it("rewrites the matching provider payload before dispatch", () => {
    type Handler = (
      event: { payload: unknown },
      ctx: { model: { provider: string; api: string } },
    ) => unknown;

    let handler: Handler | undefined;
    const pi = {
      on(event: string, candidate: Handler) {
        if (event === "before_provider_request") handler = candidate;
      },
    } as unknown as ExtensionAPI;

    registerOpenCodeGoCompatibility(pi);

    const payload = {
      stream_options: { include_usage: true },
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "prompt", cache_control: { type: "ephemeral" } }],
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read", parameters: {}, strict: false },
        },
      ],
    };
    const result = handler?.(
      { payload },
      { model: { provider: "opencode-go", api: "openai-completions" } },
    );

    assert.deepEqual(result, {
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "prompt" }],
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read", parameters: {} },
        },
      ],
    });
  });

  it("passes a minimal first-turn provider contract over HTTP", async () => {
    type Handler = (
      event: { payload: unknown },
      ctx: { model: { provider: string; api: string } },
    ) => unknown;

    let received: unknown;
    const server = http.createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        received = JSON.parse(body);

        const payload = isObject(received) ? received : {};
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        const tools = Array.isArray(payload.tools) ? payload.tools : [];
        const hasForbiddenMarker =
          ["prompt_cache_key", "prompt_cache_retention", "store", "stream_options"].some(
            (field) => field in payload,
          ) ||
          messages.some(
            (message) =>
              isObject(message) &&
              Array.isArray(message.content) &&
              message.content.some((part) => isObject(part) && "cache_control" in part),
          ) ||
          tools.some(
            (tool) =>
              isObject(tool) &&
              ("cache_control" in tool || (isObject(tool.function) && "strict" in tool.function)),
          );

        if (
          request.method !== "POST" ||
          request.url !== "/chat/completions" ||
          hasForbiddenMarker
        ) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              message: "Error from provider (Console Go): Upstream request failed",
              type: "invalid_request_error",
            }),
          );
          return;
        }

        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "chatcmpl-contract",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
        );
      } catch {
        response.writeHead(400).end();
      }
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      let handler: Handler | undefined;
      registerOpenCodeGoCompatibility({
        on(event: string, candidate: Handler) {
          if (event === "before_provider_request") handler = candidate;
        },
      } as unknown as ExtensionAPI);

      const parameters = {
        type: "object",
        properties: {
          cache_control: { type: "string" },
          strict: { type: "boolean" },
        },
      };
      const payload = {
        model: "deepseek-v4-flash",
        stream: true,
        stream_options: { include_usage: true },
        prompt_cache_key: "session",
        prompt_cache_retention: "24h",
        store: false,
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "prompt", cache_control: { type: "ephemeral" } }],
          },
          { role: "user", content: "hello" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "read", parameters, strict: false },
            cache_control: { type: "ephemeral" },
          },
        ],
      };
      const requestPayload =
        handler?.({ payload }, { model: { provider: "opencode-go", api: "openai-completions" } }) ??
        payload;
      const { port } = server.address() as AddressInfo;
      const providerResponse = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestPayload),
      });
      const responseBody = await providerResponse.text();

      assert.equal(providerResponse.status, 200, responseBody);
      assert.match(responseBody, /data: \[DONE\]/);
      assert.deepEqual(
        (received as { tools: Array<{ function: { parameters: unknown } }> }).tools[0]?.function
          .parameters,
        parameters,
      );
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
