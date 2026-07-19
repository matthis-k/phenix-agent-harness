import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;

type ProviderModel = {
  readonly api?: string;
  readonly provider?: string;
};

const UNSUPPORTED_TOP_LEVEL_FIELDS = [
  "prompt_cache_key",
  "prompt_cache_retention",
  "store",
  "stream_options",
] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutKeys(value: JsonObject, keys: readonly string[]): JsonObject {
  const next = { ...value };
  for (const key of keys) delete next[key];
  return next;
}

function sanitizeMessage(value: unknown): unknown {
  if (!isJsonObject(value) || !Array.isArray(value.content)) return value;

  let changed = false;
  const content = value.content.map((part) => {
    if (!isJsonObject(part) || !("cache_control" in part)) return part;
    changed = true;
    return withoutKeys(part, ["cache_control"]);
  });

  return changed ? { ...value, content } : value;
}

function sanitizeTool(value: unknown): unknown {
  if (!isJsonObject(value)) return value;

  let changed = false;
  let next = value;

  if ("cache_control" in next) {
    next = withoutKeys(next, ["cache_control"]);
    changed = true;
  }

  if (isJsonObject(next.function) && "strict" in next.function) {
    next = {
      ...next,
      function: withoutKeys(next.function, ["strict"]),
    };
    changed = true;
  }

  return changed ? next : value;
}

/**
 * Pi 0.80.10 supplies the normal OpenCode Go model metadata and common OpenAI
 * compatibility flags. The Go gateway still fronts heterogeneous upstreams
 * that reject optional request members not fully expressible through those
 * flags, including prompt-cache markers and streaming/tool extensions. Keep the
 * provider-bound payload to their common subset without traversing user-defined
 * tool parameter schemas.
 */
export function sanitizeOpenCodeGoPayload(value: unknown): unknown {
  if (!isJsonObject(value)) return value;

  const unsupportedFields = UNSUPPORTED_TOP_LEVEL_FIELDS.filter((field) => field in value);
  let changed = unsupportedFields.length > 0;
  const payload = changed ? withoutKeys(value, unsupportedFields) : value;

  let messages = payload.messages;
  if (Array.isArray(payload.messages)) {
    messages = payload.messages.map((message) => {
      const next = sanitizeMessage(message);
      changed ||= next !== message;
      return next;
    });
  }

  let tools = payload.tools;
  if (Array.isArray(payload.tools)) {
    tools = payload.tools.map((tool) => {
      const next = sanitizeTool(tool);
      changed ||= next !== tool;
      return next;
    });
  }

  if (!changed) return value;

  return {
    ...payload,
    ...(messages !== payload.messages ? { messages } : {}),
    ...(tools !== payload.tools ? { tools } : {}),
  };
}

export function requiresOpenCodeGoPayloadSanitization(model: ProviderModel | undefined): boolean {
  return model?.provider === "opencode-go" && model.api === "openai-completions";
}

export function requiresOpenCodeToolPreambleSanitization(
  model: ProviderModel | undefined,
): boolean {
  return model?.provider === "opencode" && model.api === "openai-completions";
}

/**
 * Tool calls contain the authoritative action. Replaying an assistant's optional
 * prose preamble alongside that call caused OpenCode free models to imitate and
 * amplify the preamble on every following tool turn, eventually producing a
 * 32,000-token repetition. Preserve the tool call exactly while omitting only
 * its non-semantic accompanying prose from subsequent provider requests.
 */
export function sanitizeOpenCodeToolPreambles(value: unknown): unknown {
  if (!isJsonObject(value) || !Array.isArray(value.messages)) return value;

  let changed = false;
  const messages = value.messages.map((message) => {
    if (
      !isJsonObject(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.tool_calls) ||
      message.tool_calls.length === 0 ||
      typeof message.content !== "string" ||
      message.content.length === 0
    ) {
      return message;
    }

    changed = true;
    return { ...message, content: null };
  });

  return changed ? { ...value, messages } : value;
}

export default function registerOpenCodeCompatibility(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    let payload = event.payload;
    if (requiresOpenCodeGoPayloadSanitization(ctx.model)) {
      payload = sanitizeOpenCodeGoPayload(payload);
    }
    if (requiresOpenCodeToolPreambleSanitization(ctx.model)) {
      payload = sanitizeOpenCodeToolPreambles(payload);
    }
    return payload === event.payload ? undefined : payload;
  });
}
