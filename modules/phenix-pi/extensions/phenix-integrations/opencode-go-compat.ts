import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;

type ProviderModel = {
  readonly api?: string;
  readonly provider?: string;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * OpenCode Go's OpenAI-compatible endpoint rejects Anthropic-style
 * `cache_control` members with a generic upstream 400. Remove only those wire
 * members while preserving the rest of the provider payload exactly.
 */
export function stripAnthropicCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = stripAnthropicCacheControl(item);
      changed ||= next !== item;
      return next;
    });
    return changed ? items : value;
  }

  if (!isJsonObject(value)) return value;

  let changed = false;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "cache_control") {
      changed = true;
      continue;
    }

    const next = stripAnthropicCacheControl(item);
    changed ||= next !== item;
    result[key] = next;
  }

  return changed ? result : value;
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
