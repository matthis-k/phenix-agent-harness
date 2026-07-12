/**
 * Transition authority type.
 *
 * Replaces the ambiguous `transitionCeiling: readonly WorkflowTransitionId[]`
 * with a tagged union that has unambiguous semantics.
 *
 * Semantics:
 *   { kind: "unrestricted" }     → all otherwise valid definition transitions are permitted
 *   { kind: "restricted", allowed: [] }     → no transitions are permitted
 *   { kind: "restricted", allowed: [...] }  → only listed transitions are permitted
 *
 * An empty restricted authority denies all transitions.
 * An unrestricted authority is the default for root sessions.
 * Child contracts must receive a concrete restricted authority.
 */

import type { WorkflowTransitionId } from "./workflow-types.ts";

/**
 * Authority over which workflow transitions may be executed.
 *
 * Root normally uses { kind: "unrestricted" }.
 * Child contracts must contain a concrete { kind: "restricted", allowed: [...] }.
 * An empty `allowed` array means no transitions are permitted.
 */
export type TransitionAuthority =
  | {
      readonly kind: "unrestricted";
    }
  | {
      readonly kind: "restricted";
      readonly allowed: readonly WorkflowTransitionId[];
    };

/**
 * Check whether a specific transition is permitted under the given authority.
 * This only checks the authority — the caller must also validate state,
 * difficulty, and mode against the definition.
 */
export function isTransitionPermitted(
  transitionId: WorkflowTransitionId,
  authority: TransitionAuthority,
): boolean {
  if (authority.kind === "unrestricted") return true;
  return authority.allowed.includes(transitionId);
}

/**
 * Convert a legacy transitionCeiling array to a TransitionAuthority.
 *
 * An empty ceiling was previously used to mean "unrestricted" in some
 * contexts and "no transitions" in others. This function treats an
 * empty array as RESTRICTED with no transitions — callers that want
 * unrestricted authority must use the explicit kind.
 *
 * This migration helper exists only during the transition. After all
 * callers use TransitionAuthority, it should be deleted.
 */
export function authorityFromCeiling(
  ceiling: readonly WorkflowTransitionId[],
): TransitionAuthority {
  if (ceiling.length === 0) {
    return { kind: "restricted", allowed: [] };
  }
  return { kind: "restricted", allowed: [...ceiling] };
}
