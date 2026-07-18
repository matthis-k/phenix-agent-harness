import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { routerStream } from "./stream-proxy.ts";
import { MODEL_SET_IDS, type ModelSetId } from "./types.ts";

export const PHENIX_PROVIDER = "phenix";
export const PHENIX_API = "phenix-router";

/** Each built-in model set is exposed as one virtual model under Phenix. */
export const PHENIX_MODEL_SETS = MODEL_SET_IDS;

/** Resolve a virtual Phenix model ID to its model-set declaration. */
export function modelSetForModelId(modelId: string): ModelSetId | undefined {
  return PHENIX_MODEL_SETS.find((id) => modelId === id);
}

/**
 * Register the virtual routing provider.
 *
 * The provider itself performs no authentication. Pi currently requires every
 * registered provider to declare an authentication method, so the inert local
 * sentinel only satisfies that registration invariant and is never forwarded.
 * Concrete routed requests resolve credentials exclusively through Pi's model
 * registry for the selected upstream provider.
 */
export function registerPhenixProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PHENIX_PROVIDER, {
    name: "Phenix",
    baseUrl: "https://phenix.invalid/router",
    apiKey: "phenix-internal",
    authHeader: false,
    api: PHENIX_API as Api,
    models: PHENIX_MODEL_SETS.map((setId) => ({
      id: setId,
      name: setId,
      api: PHENIX_API as Api,
      reasoning: true,
      input: ["text", "image"] satisfies Model<Api>["input"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 128000,
      maxTokens: 32768,
    })),
    streamSimple: routerStream,
  });
}
