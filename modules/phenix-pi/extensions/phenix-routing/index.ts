import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  loadRoutingConfig,
  validateConfig,
  buildBundledConfig,
} from "./config.ts";
import { getSessionRuntime } from "./state.ts";
import { registerPhenixProvider } from "./provider.ts";
import { modelRegistry } from "./registry.ts";

export { modelRegistry };
export {
  getActiveRouteForSession,
  setActiveRouteForSession,
} from "./stream-proxy.ts";

// ── Extension entry point ───────────────────────────────────────────────────

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

  // --- Bind model registry per session ---
  pi.on("session_start", async (_event, ctx) => {
    modelRegistry.bind(ctx);
    return {};
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    modelRegistry.bind(ctx);
    return {};
  });

  // --- agent_end ---
  pi.on("agent_end", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const runtime = getSessionRuntime(sessionId);
    runtime.turnCount += 1;
    return {};
  });

}
