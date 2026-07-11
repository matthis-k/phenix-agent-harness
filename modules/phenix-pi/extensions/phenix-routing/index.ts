import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry as PiModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

import { MODEL_SET_IDS } from "./types.ts";

import {
  loadRoutingConfig,
  validateConfig,
  buildBundledConfig,
} from "./config.ts";
import {
  type ModelRegistry as RoutingModelRegistry,
  resolveRoute,
} from "./resolver.ts";
import {
  getSessionRuntime,
} from "./state.ts";
import {
  getActiveRouteForSession,
  setActiveRouteForSession,
} from "./stream-proxy.ts";
import {
  registerPhenixProvider,
  PHENIX_PROVIDER,
  modelSetForModelId,
} from "./provider.ts";

export { getActiveRouteForSession, setActiveRouteForSession };

/**
 * Runtime bridge to Pi's active model registry.
 *
 * Phenix owns routing only. Concrete model metadata, API keys, OAuth refresh,
 * environment fallback, runtime overrides, and provider/model request headers
 * are resolved by Pi's ModelRegistry for the current extension context.
 */
class PhenixUpstreamRuntime implements RoutingModelRegistry {
  private registry?: PiModelRegistry;

  bind(ctx: ExtensionContext): void {
    this.registry = ctx.modelRegistry;
  }

  requireRegistry(): PiModelRegistry {
    if (!this.registry) {
      throw new Error("Phenix upstream registry is not initialized");
    }

    return this.registry;
  }

  getModel(provider: string, model: string): Model<Api> | undefined {
    return this.requireRegistry().find(provider, model);
  }

  async isAvailable(provider: string, model: string): Promise<boolean> {
    const concreteModel = this.getModel(provider, model);
    if (!concreteModel) return false;

    const auth = await this.requireRegistry().getApiKeyAndHeaders(concreteModel);
    return auth.ok;
  }

  getApiKeyAndHeaders(concreteModel: Model<Api>): ReturnType<PiModelRegistry["getApiKeyAndHeaders"]> {
    return this.requireRegistry().getApiKeyAndHeaders(concreteModel);
  }
}

export const modelRegistry = new PhenixUpstreamRuntime();

/**
 * Core routing extension entry point.
 *
 * Registers:
 * - The phenix virtual provider (models selected via Pi's model picker)
 * - before_agent_start / agent_end hooks for route lifecycle
 * - /phenix-route command for diagnostics
 */
export default async function phenixRouting(
  pi: ExtensionAPI,
): Promise<void> {
  const config = loadRoutingConfig();
  const bundledConfig = buildBundledConfig();

  // --- Validate bundled config at startup ---
  const diagnostics = validateConfig(config, bundledConfig);
  const startupErrors = diagnostics.filter((d) => d.severity === "error");
  if (startupErrors.length > 0) {
    console.error("[phenix-routing] Configuration errors:");
    for (const error of startupErrors) {
      console.error(`  ERROR: ${error.message}`);
    }
  }

  // --- Register virtual provider ---
  registerPhenixProvider(pi);

  // --- Session start ---
  pi.on("session_start", async (_event, ctx) => {
    modelRegistry.bind(ctx);

    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    // Initialize runtime state for this session (default model set "mixed").
    getSessionRuntime(sessionId);
    return {};
  });

  // --- before_agent_start ---
  pi.on("before_agent_start", async (_event, ctx) => {
    modelRegistry.bind(ctx);

    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const selectedModel = ctx.model;
    const selectedProvider = selectedModel?.provider;
    const selectedModelId = selectedModel?.id;

    // Only intervene for phenix provider
    if (selectedProvider !== PHENIX_PROVIDER) return {};

    const runtime = getSessionRuntime(sessionId);

    // Set model set from the selected phenix model (e.g. "mixed" from phenix/mixed).
    const explicitModelSet = selectedModelId ? modelSetForModelId(selectedModelId) : undefined;
    if (explicitModelSet) {
      runtime.modelSet = explicitModelSet;
    }

    // Resolve route for coordinator role using the model set determined from selection
    const route = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      modelRegistry,
      config,
    });

    // Store active route for stream-proxy
    runtime.activeRoute = route;
    setActiveRouteForSession(sessionId, route);

    return {};
  });

  // --- /phenix-route command ---
  pi.registerCommand("phenix-route", {
    description: "Display the current Phenix routing state",

    handler: async (_args, ctx) => {
      const sessionId = ctx.session?.id ?? "default";
      const runtime = getSessionRuntime(sessionId);
      const route = runtime.activeRoute ?? getActiveRouteForSession(sessionId);

      const availableModels = MODEL_SET_IDS.map((id) => `${PHENIX_PROVIDER}/${id}`).join(", ");

      const lines: string[] = [
        `Virtual provider: ${PHENIX_PROVIDER}`,
        `Active model set: ${runtime.modelSet}`,
        `Available model-set models: ${availableModels}`,
      ];

      if (route) {
        lines.push(
          `Difficulty: ${route.difficulty}`,
          `Role: ${route.role}`,
          `Capability: ${route.capability}`,
          `Thinking: ${route.thinking}`,
          `Candidate pool: ${route.pool}`,
          `Resolved model: ${route.model.provider}/${route.model.model}`,
          `Candidate index: ${route.candidateIndex}`,
          `Avoided-model fallback: ${route.usedAvoidedModelFallback}`,
        );
        if (route.avoidedModel) {
          lines.push(`Avoided model: ${route.avoidedModel.provider}/${route.avoidedModel.model}`);
        }
      } else {
        lines.push("No active route");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

}
