import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { ModelSetId } from "./types.ts";
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
  resolveModelSet,
  cycleModelSet,
  validateModelSet,
} from "./state.ts";
import {
  getActiveRouteForSession,
  setActiveRouteForSession,
} from "./stream-proxy.ts";
import { registerPhenixProvider, PHENIX_PROVIDER, PHENIX_MODEL } from "./provider.ts";

export { getActiveRouteForSession, setActiveRouteForSession };

const SETTINGS_KEY = "phenix-routing-settings-v1";
const ROUTE_AUDIT_KEY = "phenix-route-v1";

/**
 * Model registry implementation wrapping Pi's modelRegistry API.
 * We store a reference to the Pi API's modelRegistry when the extension initializes.
 */
class PiModelRegistry implements ModelRegistry {
  private pi: ExtensionAPI | null = null;

  setPi(pi: ExtensionAPI): void {
    this.pi = pi;
  }

  isAvailable(provider: string, model: string): boolean {
    // Check if the model exists in Pi's model registry
    if (!this.pi) return false;
    try {
      const models = this.pi.getModelRegistry()?.getModels();
      if (!models) return false;
      return models.some(
        (m: Model<Api>) =>
          m.provider === provider && m.id === model,
      );
    } catch {
      return false;
    }
  }

  getModel(provider: string, model: string): Model<Api> | undefined {
    if (!this.pi) return undefined;
    try {
      const models = this.pi.getModelRegistry()?.getModels();
      if (!models) return undefined;
      return models.find(
        (m: Model<Api>) =>
          m.provider === provider && m.id === model,
      );
    } catch {
      return undefined;
    }
  }

  getApiKeyAndHeaders(concreteModel: Model<Api>): {
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  } {
    if (!this.pi) return {};
    try {
      // The Pi API exposes apiKey lookup and header resolution
      const provider = this.pi.getProviderConfig(concreteModel.provider);
      return {
        apiKey: provider?.apiKey ?? process.env[`${concreteModel.provider.toUpperCase().replaceAll("-", "_")}_API_KEY`],
        headers: concreteModel.headers,
        env: provider?.env,
      };
    } catch {
      return {};
    }
  }
}

export const modelRegistry = new PiModelRegistry();

/**
 * Core routing extension entry point.
 *
 * Registers:
 * - The phenix virtual provider
 * - CLI flag --phenix-model-set
 * - /phenix-model-set and /phenix-route commands
 * - Ctrl+T keybinding for model-set cycling
 * - before_agent_start / agent_end hooks for route lifecycle
 * - session_start hook for session restoration
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

  // --- Parse CLI flags ---
  const cliModelSet = parseCliModelSet();

  // --- Session start ---
  pi.on("session_start", async (event: { sessionId?: string; session?: { id?: string } }) => {
    const sessionId = event.sessionId ?? "default";

    // Restore model set from session entries
    const settings = await scanSessionSettings(pi, sessionId);
    if (settings && validateModelSet(settings.modelSet)) {
      const runtime = getSessionRuntime(sessionId);
      runtime.modelSet = settings.modelSet as ModelSetId;
    }

    // CLI override
    if (cliModelSet) {
      const validated = validateModelSet(cliModelSet);
      if (validated) {
        const runtime = getSessionRuntime(sessionId);
        runtime.modelSet = validated;
      }
    }

    return {};
  });

  // --- before_agent_start ---
  pi.on("before_agent_start", async (event: { session?: { id?: string }; model?: { provider?: string }; task?: string; systemPrompt?: string }) => {
    const sessionId = event.session?.id ?? "default";
    const selectedModel = event.model;
    const selectedProvider = selectedModel?.provider;

    // Only intervene for phenix/workflow
    if (selectedProvider !== PHENIX_PROVIDER) return {};

    const runtime = getSessionRuntime(sessionId);

    // Resolve model set
    const modelSet = resolveModelSet(sessionId, cliModelSet);

    // Derive profile from task
    const taskText = event.task ?? event.systemPrompt ?? "";
    const profile = deriveCoordinatorProfile(taskText);

    // Resolve route for coordinator role
    const route = await resolveRoute({
      modelSet,
      role: "coordinator",
      profile,
      modelRegistry,
      config,
    });

    // Store active route
    runtime.activeRoute = route;
    setActiveRouteForSession(sessionId, route);

    // Append audit entry
    try {
      pi.appendEntry(ROUTE_AUDIT_KEY, {
        modelSet: route.modelSet,
        role: route.role,
        difficulty: route.difficulty,
        capability: route.capability,
        pool: route.pool,
        resolvedModel: `${route.model.provider}/${route.model.model}`,
        thinking: route.thinking,
        candidateIndex: route.candidateIndex,
        timestamp: Date.now(),
      });
    } catch {
      // Non-critical
    }

    return {};
  });

  // --- agent_end ---
  pi.on("agent_end", async (_event) => {
    // Ephemeral turn state is cleared but persisted settings survive.
    // We clear the active route per session on agent end.
    // In practice multiple sessions may be active, so we iterate.
    // For simplicity, we don't track "which session just ended" here.
    // The stream proxy already managed route cleanup.
    return {};
  });

  // --- /phenix-model-set command ---
  pi.registerCommand("phenix-model-set", {
    description: "Show or change the active Phenix model set. Usage: /phenix-model-set [free|opencode-go|gpt|mixed]",

    handler: async (args, ctx) => {
      const sessionId = ctx.session?.id ?? "default";
      const trimmed = args.trim();

      if (!trimmed) {
        const runtime = getSessionRuntime(sessionId);
        ctx.ui.notify(`Current model set: ${runtime.modelSet}`, "info");
        return;
      }

      const validated = validateModelSet(trimmed);
      if (!validated) {
        ctx.ui.notify(
          `Invalid model set "${trimmed}". Valid options: ${MODEL_SET_IDS.join(", ")}`,
          "error",
        );
        return;
      }

      const runtime = getSessionRuntime(sessionId);
      runtime.modelSet = validated;

      // Don't check for active agent turn — reject if a turn is active
      if (runtime.activeRoute) {
        ctx.ui.notify(
          `Cannot change model set while an agent turn is active. The change will apply on the next turn.`,
          "warning",
        );
        return;
      }

      // Persist the change
      try {
        pi.appendEntry(SETTINGS_KEY, {
          version: 1,
          modelSet: validated,
        });
      } catch {
        // Non-critical
      }

      ctx.ui.notify(`Model set changed to: ${validated}`, "info");
    },
  });

  // --- /phenix-route command ---
  pi.registerCommand("phenix-route", {
    description: "Display the current Phenix routing state",

    handler: async (_args, ctx) => {
      const sessionId = ctx.session?.id ?? "default";
      const runtime = getSessionRuntime(sessionId);
      const route = runtime.activeRoute ?? getActiveRouteForSession(sessionId);

      const lines: string[] = [
        `Virtual model: ${PHENIX_PROVIDER}/${PHENIX_MODEL}`,
        `Active model set: ${runtime.modelSet}`,
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

  // --- Ctrl+T keybinding ---
  const cycleOrder: ModelSetId[] = ["free", "opencode-go", "gpt", "mixed"];

  pi.registerKeybinding("ctrl+t", {
    description: "Cycle Phenix model set",
    handler: async (ctx) => {
      const sessionId = ctx.session?.id ?? "default";
      const runtime = getSessionRuntime(sessionId);

      const next = cycleModelSet(runtime.modelSet, cycleOrder);
      runtime.modelSet = next;

      try {
        pi.appendEntry(SETTINGS_KEY, {
          version: 1,
          modelSet: next,
        });
      } catch {
        // Non-critical
      }

      ctx.ui.notify(`Phenix model set: ${next}`, "info");
    },
  });

  // --- Footer state display hook ---
  // We'd register a footer callback if Pi API supports it.
  // For now, the route command provides visibility.
}

function parseCliModelSet(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--phenix-model-set" && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return undefined;
}

function deriveCoordinatorProfile(task: string): {
  complexity: number;
  uncertainty: number;
  consequence: number;
  breadth: number;
  coupling: number;
  novelty: number;
} {
  const text = task.toLowerCase();

  const highRisk = /\b(security|auth|permission|secret|credential|migration|data\s*loss|destructive|concurren|race|deadlock|protocol|public\s*api)\b/.test(text);
  const architecture = /\b(architect|redesign|state\s*machine|workflow|persistent|database|schema|interface|cross[\s-]cutting)\b/.test(text);
  const uncertainty = /\b(investigate|unknown|unclear|research|diagnose|why|root\s*cause)\b/.test(text);
  const novelty = /\b(new|introduce|design|invent|prototype|replace)\b/.test(text);

  return {
    complexity: text.length > 4000 ? 4 : text.length > 1800 ? 3 : text.length > 700 ? 2 : 1,
    uncertainty: uncertainty ? 2 : 0,
    consequence: highRisk ? 3 : 0,
    breadth: (text.match(/\n/g) ?? []).length >= 9 ? 4 : (text.match(/\n/g) ?? []).length >= 5 ? 3 : (text.match(/\n/g) ?? []).length >= 2 ? 2 : 0,
    coupling: architecture ? 3 : 0,
    novelty: novelty ? 2 : 0,
  };
}

async function scanSessionSettings(
  pi: ExtensionAPI,
  sessionId: string,
): Promise<{ version: number; modelSet: string } | undefined> {
  try {
    const entries = pi.scanEntries?.(sessionId, SETTINGS_KEY) ?? [];
    // Find the latest valid entry
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.version === 1 && entry?.modelSet) {
        return entry as { version: number; modelSet: string };
      }
    }
  } catch {
    // Session scanning not available
  }
  return undefined;
}
