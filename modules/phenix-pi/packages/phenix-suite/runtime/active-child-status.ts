import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { executionAuthorityForProject } from "../authority/registry.ts";
import type { ExecutionAuthority } from "../authority/service.ts";
import type { ActiveSubagentCountListener } from "./subagent-manager.ts";

const PHENIX_STATUS_ID = "phenix";
const TERMINAL_RUNTIME = new Set(["failed", "cancelled", "orphaned"]);
const TERMINAL_ACCEPTANCE = new Set(["accepted", "rejected", "cancelled"]);

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

function activeCountForSession(
  authority: ExecutionAuthority,
  rootSessionId: string,
  fallbackCount: number,
): number {
  const objective = authority.activeObjectiveForSession(rootSessionId);
  if (!objective) return fallbackCount;
  return authority
    .inspectObjective(objective.id)
    .handles.filter(
      (handle) =>
        !TERMINAL_RUNTIME.has(handle.runtimeState) &&
        !TERMINAL_ACCEPTANCE.has(handle.acceptanceState),
    ).length;
}

function updateStatus(ctx: ExtensionContext, activeCount: number): void {
  try {
    ctx.ui.setStatus(PHENIX_STATUS_ID, activeSubsessionStatusText(activeCount));
  } catch {
    // UI is optional and must not affect child execution.
  }
}

/**
 * Keep each root TUI status synchronized with durable handles owned by that
 * root session. Before an objective is initialized, the manager count remains
 * a bootstrap compatibility fallback; it is never combined with authority
 * handles and cannot contaminate another session's durable projection.
 */
export function registerActiveChildStatusProjection(input: {
  readonly pi: ExtensionAPI;
  readonly source: ActiveSubagentCountSource;
}): () => void {
  const contexts = new Map<string, ExtensionContext>();
  const authorities = new Map<string, ExecutionAuthority>();
  const authorityUnsubscribers = new Map<string, () => void>();
  let fallbackCount = input.source.activeCount;

  const refresh = (id: string): void => {
    const ctx = contexts.get(id);
    const authority = authorities.get(id);
    if (ctx && authority) {
      updateStatus(ctx, activeCountForSession(authority, id, fallbackCount));
    }
  };

  const unsubscribeFallback = input.source.subscribeActiveCount((activeCount) => {
    fallbackCount = activeCount;
    for (const id of contexts.keys()) refresh(id);
  });

  const rememberContext = (ctx: ExtensionContext): void => {
    const id = sessionId(ctx);
    contexts.set(id, ctx);
    const authority = executionAuthorityForProject(ctx.cwd ?? process.cwd());
    authorities.set(id, authority);
    refresh(id);
    if (!authorityUnsubscribers.has(id)) {
      authorityUnsubscribers.set(id, authority.subscribeActiveCount(() => refresh(id)));
    }
  };

  input.pi.on("session_start", async (_event, ctx) => {
    rememberContext(ctx);
  });
  input.pi.on("context", async (_event, ctx) => {
    rememberContext(ctx);
  });

  return () => {
    unsubscribeFallback();
    for (const unsubscribe of authorityUnsubscribers.values()) unsubscribe();
    authorityUnsubscribers.clear();
    authorities.clear();
    contexts.clear();
  };
}
