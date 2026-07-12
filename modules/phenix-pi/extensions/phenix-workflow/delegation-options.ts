import type {
  WorkflowDefinition,
  WorkflowRuntimeRecord,
  DelegateTransition,
  DelegationAuthority,
  DelegationOption,
  WorkflowTransition,
} from "./workflow-types.ts";
import { conditionSatisfied } from "./workflow-conditions.ts";
import { transitionMatchesDifficulty } from "./workflow-reducer.ts";
import { getOutputSchema } from "./workflow-schemas.ts";
import type { HandleRecord } from "../phenix-subagents/handle-types.ts";

// ── Resolve current delegation options ──────────────────────────────────────

/**
 * Resolve which delegation transitions are currently legal.
 *
 * Filters in order:
 * 1. Runtime state is not terminal
 * 2. Remaining depth is positive
 * 3. Transition difficulty includes runtime difficulty
 * 4. Transition scope matches (root vs child)
 * 5. Transition actor role matches
 * 6. Transition source includes current state
 * 7. Transition is in the contract transition ceiling
 * 8. Transition condition passes
 * 9. Transition target role is contract-authorized
 * 10. Transition target role is configured and available
 * 11. Transition has not exceeded maxExecutions
 * 12. Transition does not conflict with active transitions
 * 13. Background mode is removed unless root and transition explicitly permits it
 */
export function resolveDelegationOptions(input: {
  readonly definition: WorkflowDefinition;
  readonly runtime: WorkflowRuntimeRecord;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly HandleRecord[];
}): readonly DelegationOption[] {
  const { definition, runtime, authority } = input;

  const options: DelegationOption[] = [];

  // 1. Terminal state check
  const terminalStates = new Set(["completed", "failed", "cancelled"]);
  if (terminalStates.has(runtime.state)) {
    return options;
  }

  // 2. Depth must be positive
  if (authority.remainingDepth <= 0) {
    return options;
  }

  // Pre-compute context for condition evaluation
  const completedIds = new Set(runtime.completed.map((c) => c.transitionId));
  const activeIds = new Set(runtime.active.map((a) => a.transitionId));

  const context = {
    difficulty: runtime.difficulty,
    profile: runtime.taskProfile,
    facts: runtime.facts,
    completedTransitionIds: completedIds,
    activeTransitionIds: activeIds,
  };

  // Pre-compute active handle IDs for conflict detection
  const activeHandleIds = new Set(runtime.active.map((a) => a.handleId));

  for (const transition of definition.transitions) {
    // Only delegate transitions
    if (transition.kind !== "delegate") continue;

    const dt = transition as DelegateTransition;

    // 3. Difficulty match
    if (!transitionMatchesDifficulty(runtime.difficulty, dt.difficulty)) {
      continue;
    }

    // 4. Scope match
    const isRoot = runtime.actorRole === "coordinator";
    if (dt.scope === "root" && !isRoot) continue;
    if (dt.scope === "child" && isRoot) continue;

    // 5. Actor role match
    if (!dt.actorRoles.includes(runtime.actorRole as "coordinator" | "planner" | "architect" | "implementer" | "tester" | "critic" | "finalizer" | "scout")) {
      continue;
    }

    // 6. Source state match
    if (!dt.from.includes(runtime.state)) continue;

    // 7. Transition ceiling check
    if (
      authority.transitionCeiling.length > 0 &&
      !authority.transitionCeiling.includes(dt.id)
    ) {
      continue;
    }

    // 8. Condition check
    if (!conditionSatisfied(dt.condition, context)) continue;

    // 9. Role authorization check
    const authorizedRoles = authority.roles.effective;
    if (dt.role !== null && !authorizedRoles.includes(dt.role)) {
      continue;
    }
    // null role (base) is always authorized if base is in the effective set

    // 10. Role availability check
    if (dt.role !== null && !authority.availableRoles.includes(dt.role)) {
      continue;
    }

    // 11. Max executions check
    if (dt.maxExecutions !== undefined) {
      const completedCount = runtime.completed.filter(
        (c) => c.transitionId === dt.id,
      ).length;
      const activeCount = runtime.active.filter(
        (a) => a.transitionId === dt.id,
      ).length;
      if (completedCount + activeCount >= dt.maxExecutions) {
        continue;
      }
    }

    // 12. Conflict check: non-parallel transition cannot overlap
    if (!dt.parallelGroup) {
      // Check if there are any active transitions not in a parallel group
      // that would conflict with starting a new one
      const hasActiveNonParallel = runtime.active.some(() => true);
      // If there are any active transitions (non-parallel), block new ones
      // unless this is a retry/repair of the same transition
      if (hasActiveNonParallel && runtime.active.length > 0) {
        // Allow if it's the same transition and maxExecutions allows it
        const sameAlreadyActive = runtime.active.some(
          (a) => a.transitionId === dt.id,
        );
        if (!sameAlreadyActive) continue;
      }
    } else {
      // Parallel group: allow only if no same-transition is active
      const sameActive = runtime.active.filter(
        (a) => a.transitionId === dt.id,
      );
      if (sameActive.length > 0) continue;
    }

    // 13. Background mode only for root + explicitly allowed
    let allowedModes = dt.allowedModes;
    const isBackgroundAllowed = allowedModes.includes("background");
    if (isBackgroundAllowed && !isRoot) {
      allowedModes = allowedModes.filter((m) => m !== "background");
    }
    if (allowedModes.length === 0) continue;

    // All checks passed - create option
    const outputSchema = getOutputSchema(dt.outputSchemaId);

    options.push({
      transitionId: dt.id,
      workflowRevision: runtime.revision,
      role: dt.role,
      targetState: dt.onAccepted,
      purpose: dt.purpose,
      description: dt.description,
      category: dt.category,
      outputSchemaId: dt.outputSchemaId,
      outputSchema,
      allowedModes,
    });
  }

  return options;
}
