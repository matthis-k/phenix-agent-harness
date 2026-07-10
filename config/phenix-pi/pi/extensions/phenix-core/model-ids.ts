/**
 * model-ids.ts — Single canonical model ID formatting/parsing.
 *
 * Centralises all model-ID construction so that the frontend router
 * (phenix-router.ts) and subagent routing (phenix-subagent-executor.ts)
 * agree on provider vs model boundaries.
 */

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface ModelRef {
  provider: string;
  model: string;
}

// ──────────────────────────────────────────────
// Parse / format
// ──────────────────────────────────────────────

/**
 * Parse a model reference string like "opencode-go/deepseek-v4-flash"
 * into { provider, model }.
 */
export function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    throw new Error(`Invalid model ref "${ref}": expected "provider/model" format`);
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/**
 * Format a ModelRef back to "provider/model" string.
 */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/**
 * Compare two model refs for equality.
 */
export function sameModelRef(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/**
 * Resolve a model string from the routing layer to a concrete model ref,
 * applying the provider naming convention.
 *
 * If the model string already contains "/", parse it.
 * Otherwise assume it belongs to the given default provider.
 */
export function resolveModelRef(modelId: string, defaultProvider?: string): ModelRef {
  if (modelId.includes("/")) {
    return parseModelRef(modelId);
  }
  return { provider: defaultProvider ?? "opencode-go", model: modelId };
}

// ──────────────────────────────────────────────
// Known provider constants
// ──────────────────────────────────────────────

/**
 * Canonical provider names for each backend.
 * These must match what Pi's model registry exposes.
 */
export const PROVIDERS = {
  opencodeGo: "opencode-go",
  opencode: "opencode",
  openai: "openai",
  phenix: "phenix",
} as const;

/**
 * Known frontend model set IDs that map to backend provider + model.
 * The router and subagent executor both use these.
 */
export const FRONTEND_MODEL_SETS: Record<string, ModelRef> = {
  free:        { provider: PROVIDERS.opencode, model: "deepseek-v4-flash-free" },
  mixed:       { provider: PROVIDERS.opencodeGo, model: "deepseek-v4-flash" },
  "opencode-go": { provider: PROVIDERS.opencodeGo, model: "deepseek-v4-flash" },
  gpt:         { provider: PROVIDERS.openai, model: "gpt-5.5" },
};

/**
 * Default model used when no routing match is found.
 * Keep as "provider/model" string for direct CLI passthrough.
 */
export const DEFAULT_MODEL_STR = "opencode-go/deepseek-v4-flash";

export const DEFAULT_MODEL_REF: ModelRef = {
  provider: PROVIDERS.opencodeGo,
  model: "deepseek-v4-flash",
};
