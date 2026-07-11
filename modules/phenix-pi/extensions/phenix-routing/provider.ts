import type { Api, Model } from "@earendil-works/pi-ai";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MODEL_SET_IDS, type ModelSetId } from "./types.ts";

export const PHENIX_PROVIDER = "phenix";
export const PHENIX_MODEL = "workflow";
export const PHENIX_API = "phenix-router";

/**
 * Each model set is exposed as a separate model under the phenix provider,
 * e.g. phenix/opencode-go, phenix/gpt, phenix/mixed, phenix/free.
 */
export const PHENIX_MODEL_SETS = MODEL_SET_IDS;

/**
 * Determine which model set a given phenix model id maps to.
 * Returns undefined for unknown models.
 */
export function modelSetForModelId(modelId: string): ModelSetId | undefined {
  return PHENIX_MODEL_SETS.find((id) => modelId === id);
}

/**
 * Register the virtual phenix provider with Pi.
 *
 * The provider registration includes a dummy base URL and API key that
 * Pi requires for model registration but must never be sent upstream.
 * Each model set gets its own model entry so users can pick the routing
 * backend directly from the model picker.
 */
export function registerPhenixProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PHENIX_PROVIDER, {
    name: "Phenix",
    baseUrl: "https://phenix.invalid/router",
    apiKey: "phenix-internal",
    api: PHENIX_API,
    models: [
      // One model per model set so the picker explicitly chooses the routing backend
      ...PHENIX_MODEL_SETS.map((setId) => ({
        id: setId,
        name: `Phenix ${setId}`,
        api: PHENIX_API as Api,
        reasoning: true,
        input: ["text", "image"] as Model["input"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 32768,
      })),
    ],
    streamSimple: async (model, context, options) => {
      const { routerStream } = await import("./stream-proxy.ts");
      return routerStream(model, context, options);
    },
  });
}
