import type {
  DelegateTransition,
  WorkflowDefinition,
  WorkflowTransitionId,
} from "./workflow-types.ts";

/**
 * Workflow-facing target identities.
 *
 * Most transitions expose their configured agent client ID directly. A workflow
 * may assign a more specific target identity when multiple transitions from the
 * same authority context share one execution client. The internal transition ID
 * remains private to the runtime.
 */
const TARGET_AGENT_OVERRIDES: Readonly<Record<string, string>> = {
  "d3.scout-repository": "repository-scout",
  "d3.scout-tests": "test-scout",
  "d3.scout-constraints": "constraint-scout",
};

export function targetAgentForTransition(transition: DelegateTransition): string {
  return TARGET_AGENT_OVERRIDES[transition.id] ?? transition.agentClient.id;
}

export function delegateTransitionById(
  definition: WorkflowDefinition,
  transitionId: WorkflowTransitionId | string,
): DelegateTransition | undefined {
  const transition = definition.transitions.find((candidate) => candidate.id === transitionId);
  return transition?.kind === "delegate" ? transition : undefined;
}

function intersects<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.some((value) => right.includes(value));
}

function scopesOverlap(
  left: DelegateTransition["scope"],
  right: DelegateTransition["scope"],
): boolean {
  return left === "both" || right === "both" || left === right;
}

/**
 * Ensure current authority plus target agent resolves to at most one transition.
 *
 * Difficulty, actor role, scope, and current node are all contract/runtime-owned
 * context. Conditions are deliberately ignored here: target identity must remain
 * deterministic even if two conditions accidentally become true together.
 */
export function validateTargetAgentDeterminism(definition: WorkflowDefinition): string[] {
  const delegates = definition.transitions.filter(
    (transition): transition is DelegateTransition => transition.kind === "delegate",
  );
  const errors: string[] = [];

  for (let leftIndex = 0; leftIndex < delegates.length; leftIndex += 1) {
    const left = delegates[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < delegates.length; rightIndex += 1) {
      const right = delegates[rightIndex];
      if (targetAgentForTransition(left) !== targetAgentForTransition(right)) continue;
      if (!scopesOverlap(left.scope, right.scope)) continue;
      if (!intersects(left.difficulty, right.difficulty)) continue;
      if (!intersects(left.actorRoles, right.actorRoles)) continue;
      if (!intersects(left.from, right.from)) continue;

      errors.push(
        `Ambiguous workflow target agent "${targetAgentForTransition(left)}": ` +
          `transitions "${left.id}" and "${right.id}" overlap in authority context.`,
      );
    }
  }

  return errors;
}
