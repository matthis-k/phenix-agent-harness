/**
 * Session-scoped registry for workflow and capability state.
 *
 * Replaces process-global caches with session-keyed storage. Each Pi session
 * gets isolated capability artifacts and root workflow data.
 *
 * JavaScript event-loop concurrency is sufficient here: mutations are
 * synchronous and keyed by session ID. Cross-process durability belongs to the
 * file-backed workflow store, not this in-memory registry.
 */

import type { AgentCapabilityArtifact } from "./agent-capabilities.ts";
import type { DefaultWorkflowDefinitionId } from "./workflow-types.ts";

/** Workflow data installed by the routing extension during session startup. */
export interface SessionWorkflowData {
  readonly turnId: string;

  readonly instanceId: string;
  readonly actorId: string;

  readonly definitionId: DefaultWorkflowDefinitionId;

  readonly cwd: string;
}

interface SessionEntry {
  capabilityArtifact: AgentCapabilityArtifact;
  workflowData: SessionWorkflowData;
}

const sessions = new Map<string, SessionEntry>();

/** Store session-scoped capability and root-workflow state. */
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
  sessions.set(sessionId, { capabilityArtifact, workflowData });
}

/** Remove state when a Pi session ends. */
export function unregisterSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Return the capability artifact for a session.
 *
 * Missing state is represented explicitly so callers can fail closed.
 */
export function getSessionCapabilityArtifact(
  sessionId: string,
): AgentCapabilityArtifact | undefined {
  return sessions.get(sessionId)?.capabilityArtifact;
}

/** Return root workflow data for a session, when registered. */
export function getSessionWorkflowData(sessionId: string): SessionWorkflowData | undefined {
  return sessions.get(sessionId)?.workflowData;
}

/** Require the capability artifact installed during session startup. */
export function requireSessionCapabilityArtifact(sessionId: string): AgentCapabilityArtifact {
  const artifact = getSessionCapabilityArtifact(sessionId);

  if (!artifact) {
    throw new Error(`No Phenix capability artifact is registered for session "${sessionId}".`);
  }

  return artifact;
}

/** Require root workflow data installed during session startup. */
export function requireSessionWorkflowData(sessionId: string): SessionWorkflowData {
  const workflow = getSessionWorkflowData(sessionId);

  if (!workflow) {
    throw new Error(`No Phenix root workflow is registered for session "${sessionId}".`);
  }

  return workflow;
}

/** Number of active sessions, exposed for diagnostics and tests. */
export function activeSessionCount(): number {
  return sessions.size;
}

/** Clear all session state. Intended for deterministic tests only. */
export function clearAllSessions(): void {
  sessions.clear();
}
