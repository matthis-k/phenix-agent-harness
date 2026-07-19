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
 * Convert a transition ceiling array into a restricted authority.
 * An empty array produces a deny-all authority.
 */
export function authorityFromCeiling(
  ceiling: readonly WorkflowTransitionId[],
): TransitionAuthority {
  return {
    kind: "restricted",
    allowed: ceiling,
  };
}
