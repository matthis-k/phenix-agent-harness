import type { Difficulty } from "@matthis-k/phenix-kernel/task.ts";
import type {
  DelegateTransition,
  WorkflowFactKey,
  WorkflowRuntimeRecord,
  WorkflowStateId,
} from "./workflow-types.ts";
import { outputSchemaIdForContract } from "./workflow-types.ts";

// ── Facts extractor ─────────────────────────────────────────────────────────

/**
 * Extract deterministic workflow facts from a completed delegate transition result.
 */
export function factsFromTransitionResult(
  transition: DelegateTransition,
  value: unknown,
): Readonly<Record<WorkflowFactKey, unknown>> {
  const facts: Record<WorkflowFactKey, unknown> = {};

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return facts;
  }

  const obj = value as Record<string, unknown>;

  switch (outputSchemaIdForContract(transition.outputContract)) {
    case "planner-handoff":
      if (typeof obj.crossCuttingDesignRequired === "boolean") {
        facts.crossCuttingDesignRequired = obj.crossCuttingDesignRequired;
      }
      break;
    case "implementation-handoff":
      if (typeof obj.requiresDedicatedTesting === "boolean") {
        facts.requiresDedicatedTesting = obj.requiresDedicatedTesting;
      }
      if (typeof obj.behaviorChanged === "boolean") {
        facts.behaviorChanged = obj.behaviorChanged;
      }
      break;
    case "test-handoff":
      if (typeof obj.coverageSatisfactory === "boolean") {
        facts.coverageSatisfactory = obj.coverageSatisfactory;
      }
      break;
    case "critic-handoff":
      if (typeof obj.verdict === "string") {
        facts.criticVerdict = obj.verdict;
      }
      break;
    default:
      break;
  }

  return facts;
}

// ── State advancement ───────────────────────────────────────────────────────

/**
 * Advance workflow state when a transition is accepted.
 * This handles the state transition itself - the store manages revision and concurrency.
 */
export function advanceWorkflowState(
  _record: WorkflowRuntimeRecord,
  transition: DelegateTransition,
  accepted: boolean,
): WorkflowStateId {
  return accepted ? transition.onAccepted : transition.onRejected;
}

// ── Transition path helpers ─────────────────────────────────────────────────

const TERMINAL_STATES: ReadonlySet<WorkflowStateId> = new Set([
  "completed",
  "failed",
  "cancelled",
  "abandoned",
]);

export function isTerminalState(state: WorkflowStateId): boolean {
  return TERMINAL_STATES.has(state);
}

// ── Difficulty matching ─────────────────────────────────────────────────────

export function transitionMatchesDifficulty(
  difficulty: Difficulty,
  allowed: readonly Difficulty[],
): boolean {
  return allowed.includes(difficulty);
}
