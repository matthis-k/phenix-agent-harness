import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ActiveSubagentCountListener } from "./subagent-manager.ts";

const PHENIX_STATUS_ID = "phenix";

export interface ActiveSubagentCountSource {
  readonly activeCount: number;
  subscribeActiveCount(listener: ActiveSubagentCountListener): () => void;
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() ?? "default";
}

export function activeSubsessionStatusText(activeCount: number): string {
  return `Phenix · ${activeCount} active subsession${activeCount === 1 ? "" : "s"}`;
}

function updateStatus(ctx: ExtensionContext, activeCount: number): void {
  try {
    ctx.ui.setStatus(PHENIX_STATUS_ID, activeSubsessionStatusText(activeCount));
  } catch {
    // UI is optional and must not affect child execution.
  }
}

/**
 * Keep the root TUI status synchronized with the shared child-session directory.
 *
 * Pi's `context` event is not emitted while an awaited child is running, so a
 * context-only projection observes zero before spawn and zero after cleanup.
 * This projection retains the live root session contexts and refreshes them on
 * directory add/remove notifications instead.
 */
export function registerActiveChildStatusProjection(input: {
  readonly pi: ExtensionAPI;
  readonly source: ActiveSubagentCountSource;
}): () => void {
  const contexts = new Map<string, ExtensionContext>();

  const rememberContext = (ctx: ExtensionContext): void => {
    contexts.set(sessionId(ctx), ctx);
    updateStatus(ctx, input.source.activeCount);
  };

  input.pi.on("session_start", async (_event, ctx) => {
    rememberContext(ctx);
  });
  input.pi.on("context", async (_event, ctx) => {
    rememberContext(ctx);
  });

  const unsubscribe = input.source.subscribeActiveCount((activeCount) => {
    for (const ctx of contexts.values()) updateStatus(ctx, activeCount);
  });

  return () => {
    unsubscribe();
    contexts.clear();
  };
}
