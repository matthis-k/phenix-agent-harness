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
 * OpenCode Go fronts several upstream providers behind an OpenAI-compatible
 * endpoint. Those upstreams accept the core Chat Completions contract but do
 * not consistently accept optional OpenAI fields. Keep the wire payload to the
 * common subset without traversing user-defined tool parameter schemas.
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

export default function registerOpenCodeGoCompatibility(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    if (!requiresOpenCodeGoPayloadSanitization(ctx.model)) return;

    const payload = sanitizeOpenCodeGoPayload(event.payload);
    return payload === event.payload ? undefined : payload;
  });
}
