import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadRoutingConfig, validateConfig } from "./config.ts";
import { registerPhenixProvider } from "./provider.ts";
import { modelRegistry } from "./registry.ts";
import { getSessionRuntime } from "./state.ts";
import {
  clearStreamTraceSession,
  streamTraceEnabled,
  streamTraceEventFields,
  streamTraceIdForSession,
  streamTraceMessageFields,
  writeStreamTrace,
} from "./stream-trace.ts";

export {
  getActiveRouteForSession,
  setActiveRouteForSession,
} from "./stream-proxy.ts";
export { modelRegistry };

function isAssistantMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as Record<string, unknown>).role === "assistant"
  );
}

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

  const assemblySequenceByTrace = new Map<string, number>();

  pi.on("session_start", (_event, ctx) => {
    modelRegistry.bind(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    modelRegistry.bind(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (!streamTraceEnabled() || !isAssistantMessage(event.message)) return;
    const currentSessionId = ctx.sessionManager.getSessionId() ?? "default";
    const traceId = streamTraceIdForSession(currentSessionId);
    if (!traceId) return;

    const assemblySequence = (assemblySequenceByTrace.get(traceId) ?? 0) + 1;
    assemblySequenceByTrace.set(traceId, assemblySequence);
    writeStreamTrace({
      boundary: "pi_message_update",
      traceId,
      sessionId: currentSessionId,
      assemblySequence,
      ...streamTraceEventFields(event.assistantMessageEvent),
      ...streamTraceMessageFields(event.message),
    });
  });

  pi.on("message_end", (event, ctx) => {
    if (!streamTraceEnabled() || !isAssistantMessage(event.message)) return;
    const currentSessionId = ctx.sessionManager.getSessionId() ?? "default";
    const traceId = streamTraceIdForSession(currentSessionId);
    if (!traceId) return;

    writeStreamTrace({
      boundary: "pi_message_finalized",
      traceId,
      sessionId: currentSessionId,
      assemblySequence: assemblySequenceByTrace.get(traceId) ?? 0,
      ...streamTraceMessageFields(event.message),
    });
  });

  pi.on("agent_end", (event, ctx) => {
    const currentSessionId = ctx.sessionManager.getSessionId() ?? "default";
    if (streamTraceEnabled()) {
      const traceId = streamTraceIdForSession(currentSessionId);
      if (traceId) {
        let finalAssistant: unknown;
        for (let index = event.messages.length - 1; index >= 0; index -= 1) {
          const candidate = event.messages[index];
          if (isAssistantMessage(candidate)) {
            finalAssistant = candidate;
            break;
          }
        }
        writeStreamTrace({
          boundary: "pi_agent_end",
          traceId,
          sessionId: currentSessionId,
          messageCount: event.messages.length,
          assemblySequence: assemblySequenceByTrace.get(traceId) ?? 0,
          ...streamTraceMessageFields(finalAssistant),
        });
      }
    }
    getSessionRuntime(currentSessionId).turnCount += 1;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const currentSessionId = ctx.sessionManager.getSessionId() ?? "default";
    const traceId = streamTraceIdForSession(currentSessionId);
    if (traceId) assemblySequenceByTrace.delete(traceId);
    clearStreamTraceSession(currentSessionId);
  });
}
