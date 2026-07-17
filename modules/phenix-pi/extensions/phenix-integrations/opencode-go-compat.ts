import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;

type ProviderModel = {
  readonly api?: string;
  readonly provider?: string;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutCacheControl(value: JsonObject): JsonObject {
  const { cache_control: _cacheControl, ...rest } = value;
  return rest;
}

function sanitizeMessage(value: unknown): unknown {
  if (!isJsonObject(value) || !Array.isArray(value.content)) return value;

  let changed = false;
  const content = value.content.map((part) => {
    if (!isJsonObject(part) || !("cache_control" in part)) return part;
    changed = true;
    return withoutCacheControl(part);
  });

  return changed ? { ...value, content } : value;
}

function sanitizeTool(value: unknown): unknown {
  return isJsonObject(value) && "cache_control" in value ? withoutCacheControl(value) : value;
}

/**
 * OpenCode Go's OpenAI-compatible endpoint rejects Anthropic-style
 * `cache_control` members with a generic upstream 400. Pi emits those markers
 * only on message content blocks and top-level tool declarations, so sanitize
 * those locations without traversing user-defined tool schemas.
 */
export function stripAnthropicCacheControl(value: unknown): unknown {
  if (!isJsonObject(value)) return value;

  let changed = false;
  let messages = value.messages;
  if (Array.isArray(value.messages)) {
    messages = value.messages.map((message) => {
      const next = sanitizeMessage(message);
      changed ||= next !== message;
      return next;
    });
  }

  let tools = value.tools;
  if (Array.isArray(value.tools)) {
    tools = value.tools.map((tool) => {
      const next = sanitizeTool(tool);
      changed ||= next !== tool;
      return next;
    });
  }

  return changed ? { ...value, messages, tools } : value;
}

export function requiresOpenCodeGoPayloadSanitization(
  model: ProviderModel | undefined,
): boolean {
  return model?.provider === "opencode-go" && model.api === "openai-completions";
}

export default function registerOpenCodeGoCompatibility(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    if (!requiresOpenCodeGoPayloadSanitization(ctx.model)) return;

    const payload = stripAnthropicCacheControl(event.payload);
    return payload === event.payload ? undefined : payload;
  });
}
