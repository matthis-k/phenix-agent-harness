import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerOpenCodeGoCompatibility, {
  requiresOpenCodeGoPayloadSanitization,
  stripAnthropicCacheControl,
} from "../extensions/phenix-integrations/opencode-go-compat.ts";

describe("OpenCode Go payload compatibility", () => {
  it("removes wire cache markers without changing tool schemas", () => {
    const parameters = {
      type: "object",
      properties: {
        cache_control: { type: "string" },
      },
    };
    const payload = {
      model: "deepseek-v4-flash",
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
          function: { name: "read", parameters },
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    assert.deepEqual(stripAnthropicCacheControl(payload), {
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

  it("preserves payload identity when no cache markers are present", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
    };

    assert.equal(stripAnthropicCacheControl(payload), payload);
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
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "prompt", cache_control: { type: "ephemeral" } }],
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
    });
  });
});
