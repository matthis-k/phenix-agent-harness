import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MODEL_SET_IDS } from "./types.ts";

// Read the phenix-subagents skill content — this is auto-invoked for Phenix models.
const phenixSubagentsSkillPath = fileURLToPath(
  new URL("../../skills/phenix-subagents/SKILL.md", import.meta.url)
);
const phenixSubagentsSkillRaw = readFileSync(phenixSubagentsSkillPath, "utf-8");
// Strip YAML frontmatter (--- ... ---) to get just the markdown body.
const phenixSubagentsSkillContent = phenixSubagentsSkillRaw.replace(
  /^---[\s\S]*?---\n*/,
  ""
);

import {
  loadRoutingConfig,
  validateConfig,
  buildBundledConfig,
} from "./config.ts";
import {
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

import { modelRegistry } from "./registry.ts";

export { modelRegistry, getActiveRouteForSession, setActiveRouteForSession };

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

    // Auto-invoke the phenix-subagents skill: inject its full content.
    const workflowGuidance = [
      `## Phenix Workflow Orchestration`,
      ``,
      `You are running with a Phenix model set (${runtime.modelSet}). The phenix-subagents skill is automatically invoked. Every task must use the workflow pipeline below — complexity determines pipeline depth, not whether delegation is used.`,
      ``,
      phenixSubagentsSkillContent,
    ].join("\n");

    return {
      systemPrompt: `${_event.systemPrompt}\n\n${workflowGuidance}`,
    };
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
