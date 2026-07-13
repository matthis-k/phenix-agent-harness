/**
 * Session-scoped registry for workflow and capability state.
 *
 * Replaces process-global caches (setCachedCapabilityArtifact /
 * setRootWorkflowData) with session-keyed storage. Each Pi session
 * gets its own isolated capability artifact and root workflow data.
 *
 * Threading model: JavaScript is single-threaded and Pi sessions are
 * event-loop concurrent. A Map keyed by session ID is safe without
 * additional locking because only one session operates at a time
 * within the event loop, and within a session only one agent operates
 * at a time. No cross-session mutations race.
 */

import type { AgentCapabilityArtifact } from "./agent-capabilities.ts";
import type { DefaultWorkflowDefinitionId } from "./workflow-types.ts";

// ── Session-scoped workflow data ─────────────────────────────────────────────

/** Workflow data set by the routing extension during session startup. */
export interface SessionWorkflowData {
  readonly turnId: string;

  readonly instanceId: string;
  readonly actorId: string;

  readonly definitionId: DefaultWorkflowDefinitionId;
  readonly definitionVersion: 1;

  readonly cwd: string;
}

// ── Per-session state ───────────────────────────────────────────────────────

interface SessionEntry {
  capabilityArtifact: AgentCapabilityArtifact;
  workflowData: SessionWorkflowData;
}

const _sessions = new Map<string, SessionEntry>();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Store session-scoped state.
 *
 * Called by the routing extension during session startup
 * before any delegates or agents run.
 */
export function registerSession(
  sessionId: string,
  {
    capabilityArtifact,
    workflowData,
  }: {
    capabilityArtifact: AgentCapabilityArtifact;
    workflowData: SessionWorkflowData;
  },
): void {
  _sessions.set(sessionId, { capabilityArtifact, workflowData });
}

/**
 * Remove session state when the session ends.
 */
export function unregisterSession(sessionId: string): void {
  _sessions.delete(sessionId);
}

/**
 * Get the capability artifact for a session.
 *
 * Returns undefined if no session is registered — caller must
 * handle this by failing closed rather than building a fallback.
 */
export function getSessionCapabilityArtifact(
  sessionId: string,
): AgentCapabilityArtifact | undefined {
  return _sessions.get(sessionId)?.capabilityArtifact;
}

/**
 * Get the root workflow data for a session.
 *
 * Returns undefined if no session is registered.
 */
export function getSessionWorkflowData(sessionId: string): SessionWorkflowData | undefined {
  return _sessions.get(sessionId)?.workflowData;
}

// ── Require variants (fail-closed) ──────────────────────────────────────────

/**
 * Get the capability artifact for a session, throwing if not registered.
 * Fail-closed: a missing artifact is a hard error.
 */
export function requireSessionCapabilityArtifact(sessionId: string): AgentCapabilityArtifact {
  const artifact = getSessionCapabilityArtifact(sessionId);

  if (!artifact) {
    throw new Error(`No Phenix capability artifact is registered ` + `for session "${sessionId}".`);
  }

  return artifact;
}

/**
 * Get the root workflow data for a session, throwing if not registered.
 * Fail-closed: missing workflow data is a hard error.
 */
export function requireSessionWorkflowData(sessionId: string): SessionWorkflowData {
  const workflow = getSessionWorkflowData(sessionId);

  if (!workflow) {
    throw new Error(`No Phenix root workflow is registered ` + `for session "${sessionId}".`);
  }

  return workflow;
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

/** Number of active sessions (for testing and monitoring). */
export function activeSessionCount(): number {
  return _sessions.size;
}

/** Clear all sessions (for testing only). */
export function clearAllSessions(): void {
  _sessions.clear();
}
