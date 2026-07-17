import type { TransitionCondition, WorkflowConditionContext } from "./workflow-types.ts";

// ── Condition evaluator ─────────────────────────────────────────────────────

/**
 * Evaluate a deterministic transition condition.
 * Returns true if the condition is satisfied (or undefined/always).
 */
export function conditionSatisfied(
  condition: TransitionCondition | undefined,
  context: WorkflowConditionContext,
): boolean {
  if (condition === undefined) return true;

  switch (condition.kind) {
    case "always":
      return true;

    case "profile-at-least": {
      const value = context.profile[condition.field];
      if (typeof value !== "number") return false;
      return value >= condition.value;
    }

    case "workflow-fact": {
      const fact = context.facts[condition.key];
      return fact === condition.equals;
    }

    case "transition-completed":
      return context.completedTransitionIds.has(condition.transitionId);

    case "all":
      return condition.conditions.every((c) => conditionSatisfied(c, context));

    case "any":
      return condition.conditions.some((c) => conditionSatisfied(c, context));

    case "not":
      return !conditionSatisfied(condition.condition, context);

    default: {
      // Exhaustive check
      const _exhaustive: never = condition;
      void _exhaustive;
      return false;
    }
  }
}
