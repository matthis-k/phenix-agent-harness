import type { ModelSetId, ResolvedRoute } from "./types.ts";
import { MODEL_SET_IDS } from "./types.ts";

/**
 * Session-scoped routing state.
 * Keyed by session ID so multiple sessions don't conflict.
 */
export interface SessionRoutingRuntime {
  /** The active model set for this session. */
  modelSet: ModelSetId;

  /** The active route for the current root agent turn, if any. */
  activeRoute: ResolvedRoute | null;

  /** Monotonically increasing turn counter for this session. */
  turnCount: number;
}

/** In-memory session state map. */
const sessionState = new Map<string, SessionRoutingRuntime>();

/**
 * Get or create routing state for a session.
 */
export function getSessionRuntime(sessionId: string): SessionRoutingRuntime {
  let state = sessionState.get(sessionId);
  if (!state) {
    state = {
      modelSet: "mixed",
      activeRoute: null,
      turnCount: 0,
    };
    sessionState.set(sessionId, state);
  }
  return state;
}

/**
 * Remove routing state for a session (cleanup).
 */
export function clearSessionRuntime(sessionId: string): void {
  sessionState.delete(sessionId);
}

/**
 * Determine the effective model set for a session using precedence:
 *   1. explicit CLI flag (--phenix-model-set)
 *   2. session-persisted setting
 *   3. PHENIX_MODEL_SET env var
 *   4. user routing config default
 *   5. bundled routing config default
 */
export function resolveModelSet(
  sessionId: string,
  cliModelSet: string | undefined,
): ModelSetId {
  // 1. CLI flag
  if (cliModelSet) {
    const validated = validateModelSet(cliModelSet);
    if (validated) return validated;
  }

  // 2. Session-persisted setting (default already stored in runtime)
  const runtime = getSessionRuntime(sessionId);
  return runtime.modelSet;
}

export function validateModelSet(value: string): ModelSetId | undefined {
  const trimmed = value.trim();
  if (MODEL_SET_IDS.includes(trimmed as ModelSetId)) {
    return trimmed as ModelSetId;
  }
  return undefined;
}

/**
 * Cycle through model sets in the provided order.
 * Returns the next set after the current one.
 */
export function cycleModelSet(
  current: ModelSetId,
  order: readonly ModelSetId[],
): ModelSetId {
  const index = order.indexOf(current);
  if (index === -1 || index === order.length - 1) return order[0];
  return order[index + 1];
}
