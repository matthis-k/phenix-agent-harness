import { loadRoutingConfig } from "./config.ts";
import type { ModelSetId, ResolvedRoute } from "./types.ts";

export interface SessionCapabilityArtifactView {
  readonly artifactHash: string;
  readonly entries?: readonly unknown[];
}

/** Session-scoped routing state keyed by Pi session ID. */
export interface SessionRoutingRuntime {
  /** Active model set for the session. */
  modelSet: ModelSetId;

  /** Active route for the current root-agent turn, if any. */
  activeRoute: ResolvedRoute | null;

  /** Monotonically increasing turn counter for the session. */
  turnCount: number;

  /** Stable identity of the current logical user turn. */
  currentTurnId?: string;

  /** Number of user-submitted root turns seen by before_agent_start. */
  rootTurnCount: number;

  /** Immutable agent-capability artifact discovered at session startup. */
  capabilityArtifact?: SessionCapabilityArtifactView;

  /** Active root workflow identity. */
  activeWorkflow?: {
    readonly instanceId: string;
    readonly actorId: string;
  };
}

const sessionState = new Map<string, SessionRoutingRuntime>();

/** Return existing session state or initialize it from canonical defaults. */
export function getSessionRuntime(sessionId: string): SessionRoutingRuntime {
  const existing = sessionState.get(sessionId);
  if (existing) return existing;

  const state: SessionRoutingRuntime = {
    modelSet: loadRoutingConfig().defaultModelSet,
    activeRoute: null,
    turnCount: 0,
    rootTurnCount: 0,
  };
  sessionState.set(sessionId, state);
  return state;
}

/** Remove routing state after a Pi session is closed. */
export function clearSessionRuntime(sessionId: string): void {
  sessionState.delete(sessionId);
}

/** Parse an external model-set name against the linked built-in vocabulary. */
export function validateModelSet(value: string): ModelSetId | undefined {
  const trimmed = value.trim();
  return loadRoutingConfig().modelSetOrder.find((modelSet) => modelSet === trimmed);
}

/** Determine the effective model set for a session. */
export function resolveModelSet(sessionId: string, _cliModelSet: string | undefined): ModelSetId {
  return getSessionRuntime(sessionId).modelSet;
}

/** Cycle through a non-empty model-set order. */
export function cycleModelSet(current: ModelSetId, order: readonly ModelSetId[]): ModelSetId {
  const first = order[0];
  if (!first) {
    throw new Error("Cannot cycle an empty model-set order");
  }

  const index = order.indexOf(current);
  if (index === -1 || index === order.length - 1) return first;
  return order[index + 1] ?? first;
}
