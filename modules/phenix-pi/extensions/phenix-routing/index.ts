import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadRoutingConfig, validateConfig } from "./config.ts";
import { registerPhenixProvider } from "./provider.ts";
import { modelRegistry } from "./registry.ts";
import { getSessionRuntime } from "./state.ts";

export {
  getActiveRouteForSession,
  setActiveRouteForSession,
} from "./stream-proxy.ts";
export { modelRegistry };

/** Register the virtual provider and bind per-session routing state. */
export default async function phenixRouting(pi: ExtensionAPI): Promise<void> {
  const diagnostics = validateConfig(loadRoutingConfig());
  const startupErrors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (startupErrors.length > 0) {
    console.error("[phenix-routing] Configuration errors:");
    for (const error of startupErrors) {
      console.error(`  ERROR: ${error.message}`);
    }
  }

  registerPhenixProvider(pi);

  pi.on("session_start", (_event, ctx) => {
    modelRegistry.bind(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    modelRegistry.bind(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    getSessionRuntime(sessionId).turnCount += 1;
  });
}
