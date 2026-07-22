import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { executionAuthorityForProject } from "../authority/registry.ts";
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
 * Keep the root TUI status synchronized with durable authority handles.
 *
 * The legacy manager source remains accepted as an adapter-compatibility input,
 * but it is no longer authoritative. This prevents process-local directory
 * cleanup or parent-turn timing from incorrectly displaying zero active work.
 */
export function registerActiveChildStatusProjection(input: {
  readonly pi: ExtensionAPI;
  readonly source: ActiveSubagentCountSource;
}): () => void {
  const contexts = new Map<string, ExtensionContext>();
  const authorityUnsubscribers = new Map<string, () => void>();

  const rememberContext = (ctx: ExtensionContext): void => {
    const id = sessionId(ctx);
    contexts.set(id, ctx);
    const authority = executionAuthorityForProject(ctx.cwd);
    updateStatus(ctx, authority.activeCount);
    if (!authorityUnsubscribers.has(id)) {
      authorityUnsubscribers.set(
        id,
        authority.subscribeActiveCount((activeCount) => {
          const current = contexts.get(id);
          if (current) updateStatus(current, activeCount);
        }),
      );
    }
  };

  input.pi.on("session_start", async (_event, ctx) => {
    rememberContext(ctx);
  });
  input.pi.on("context", async (_event, ctx) => {
    rememberContext(ctx);
  });

  return () => {
    for (const unsubscribe of authorityUnsubscribers.values()) unsubscribe();
    authorityUnsubscribers.clear();
    contexts.clear();
  };
}
