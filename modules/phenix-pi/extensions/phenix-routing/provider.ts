import type { Api, Model } from "@earendil-works/pi-ai";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PHENIX_PROVIDER = "phenix";
export const PHENIX_MODEL = "workflow";
export const PHENIX_API = "phenix-router";

/**
 * Register the virtual phenix provider with Pi.
 *
 * The provider registration includes a dummy base URL and API key that
 * Pi requires for model registration but must never be sent upstream.
 */
export function registerPhenixProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PHENIX_PROVIDER, {
    name: "Phenix",
    baseUrl: "https://phenix.invalid/router",
    apiKey: "phenix-internal",
    api: PHENIX_API,
    models: [
      {
        id: PHENIX_MODEL,
        name: "Phenix Workflow",
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
      },
    ],
    streamSimple: async (model, context, options) => {
      const { routerStream } = await import("./stream-proxy.ts");
      return routerStream(model, context, options);
    },
  });
}
