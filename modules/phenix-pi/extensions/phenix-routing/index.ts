import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

import { MODEL_SET_IDS } from "./types.ts";

import {
  loadRoutingConfig,
  validateConfig,
  buildBundledConfig,
} from "./config.ts";
import {
  type ModelRegistry,
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
 * Model registry implementation wrapping Pi's modelRegistry API.
 * We store a reference to the Pi API's modelRegistry when the extension initializes.
 */
class PiModelRegistry implements ModelRegistry {
  private pi: ExtensionAPI | null = null;

  setPi(pi: ExtensionAPI): void {
    this.pi = pi;
  }

  isAvailable(_provider: string, _model: string): boolean {
    // Optimistic: return true so the router attempts the upstream call.
    // Actual availability is determined by the concrete provider's
    // streamSimple at runtime.
    return true;
  }

  getModel(provider: string, model: string): Model<Api> | undefined {
    if (!this.pi) return undefined;
    try {
      const registry = this.pi.getModelRegistry();
      if (!registry) return undefined;
      // Use find() which is the correct method on Pi's ModelRegistry class.
      // getModel() exists on the Models interface (different class — pi-ai's
      // runtime collection). Both should work; try find first.
      if (typeof (registry as Record<string, unknown>).find === "function") {
        return (registry as { find(p: string, m: string): Model<Api> | undefined }).find(provider, model);
      }
      // Fallback to getAll() + find.
      const models = registry.getAll();
      if (!models) return undefined;
      return models.find(
        (m: Model<Api>) =>
          m.provider === provider && m.id === model,
      );
    } catch {
      return undefined;
    }
  }

  /** Read Pi's auth.json to get the API key for a provider. */
  private readAuthKey(provider: string): string | undefined {
    try {
      const agentDir =
        process.env.PI_CODING_AGENT_DIR ??
        path.join(os.homedir(), ".pi", "agent");
      const authPath = path.join(agentDir, "auth.json");
      const raw = fs.readFileSync(authPath, "utf-8");
      const auth = JSON.parse(raw) as Record<string, { type: string; key: string }>;
      return auth[provider]?.key;
    } catch {
      return undefined;
    }
  }

  getApiKeyAndHeaders(concreteModel: Model<Api>): {
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  } {
    // Read the API key from Pi's auth.json, which is where /login stores
    // credentials.  The compat-layer streamSimple routes through an in-memory
    // credential store that does NOT have these, so we must pass it explicitly.
    const apiKey = this.readAuthKey(concreteModel.provider);
    return { apiKey, headers: concreteModel.headers };
  }
}

export const modelRegistry = new PiModelRegistry();

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
  modelRegistry.setPi(pi);

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
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    // Initialize runtime state for this session (default model set "mixed").
    getSessionRuntime(sessionId);
    return {};
  });

  // --- before_agent_start ---
  pi.on("before_agent_start", async (_event, ctx) => {
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
