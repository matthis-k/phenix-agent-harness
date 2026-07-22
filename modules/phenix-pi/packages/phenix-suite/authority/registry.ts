import path from "node:path";

import { recordSessionExecutionEvent } from "../journal/session-execution-journal-registry.ts";
import { findProjectRoot } from "../subagents/handle-store.ts";
import { createExecutionAuthority } from "./factory.ts";
import type { ExecutionAuthority } from "./service.ts";
import { FileExecutionAuthorityStore } from "./store.ts";

const authorities = new Map<string, ExecutionAuthority>();
const TERMINAL_RUNTIME = new Set(["failed", "cancelled", "orphaned"]);
const TERMINAL_ACCEPTANCE = new Set(["accepted", "rejected", "cancelled"]);

function registerJournalProjection(root: string, authority: ExecutionAuthority): void {
  authority.subscribe((event) => {
    try {
      const snapshot = authority.inspectObjective(event.objectiveId);
      const node = event.nodeId
        ? snapshot.nodes.find((candidate) => candidate.id === event.nodeId)
        : undefined;
      const handle = event.handleId
        ? snapshot.handles.find((candidate) => candidate.id === event.handleId)
        : undefined;
      const activeHandleCount = snapshot.handles.filter(
        (candidate) =>
          !TERMINAL_RUNTIME.has(candidate.runtimeState) &&
          !TERMINAL_ACCEPTANCE.has(candidate.acceptanceState),
      ).length;

      recordSessionExecutionEvent(root, {
        rootSessionId: snapshot.objective.rootSessionId,
        sessionId: snapshot.objective.rootSessionId,
        actorId: event.actorId,
        objectiveId: event.objectiveId,
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        ...(event.handleId ? { handleId: event.handleId } : {}),
        ...(handle?.childRunId ? { childRunId: handle.childRunId } : {}),
        type: `authority.${event.type}`,
        payload: {
          authorityEventId: event.id,
          authoritySequence: event.sequence,
          objectiveRevision: event.revision,
          objectiveState: snapshot.objective.state,
          activeHandleCount,
          ...(node ? { node } : {}),
          ...(handle ? { handle } : {}),
          ...(event.data ? { data: event.data } : {}),
        },
      });
    } catch {
      // The authority state is already durable. Journal projection failures are
      // isolated so diagnostics cannot corrupt or roll back committed execution.
    }
  });
}

export function executionAuthorityForProject(cwd: string): ExecutionAuthority {
  const root = findProjectRoot(cwd);
  const existing = authorities.get(root);
  if (existing) return existing;
  const authority = createExecutionAuthority({
    store: new FileExecutionAuthorityStore(
      path.join(root, ".phenix-agent-state", "authority", "execution.json"),
    ),
  });
  registerJournalProjection(root, authority);
  authorities.set(root, authority);
  return authority;
}

export function clearExecutionAuthorityRegistry(): void {
  authorities.clear();
}

export function registeredExecutionAuthorities(): readonly ExecutionAuthority[] {
  return [...authorities.values()];
}
