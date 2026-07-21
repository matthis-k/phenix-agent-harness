import type { ModelWorkflowProjection } from "@matthis-k/phenix-flow/workflow-projection.ts";

import type { VerificationResult } from "./producer-cycle-runner.ts";

export const WORKFLOW_REQUIRED_TRANSITION = "WORKFLOW_REQUIRED_TRANSITION" as const;

/**
 * Convert outstanding required workflow authority into a deterministic
 * acceptance rejection. Optional transitions never block completion.
 */
export function requiredWorkflowCompletionGate(
  projection: ModelWorkflowProjection,
): VerificationResult | undefined {
  const required = projection.options.filter((option) => option.category === "required");
  if (required.length === 0) return undefined;

  return {
    ok: false,
    issues: required.map((option) => ({
      path: ["workflow", option.transitionId],
      code: WORKFLOW_REQUIRED_TRANSITION,
      message:
        `Required workflow transition "${option.transitionId}" to agent "${option.agent}" remains. ` +
        `Call phenix_workflow with action "spawn" and agent "${option.agent}" before resubmitting.`,
    })),
    summary: {
      acceptanceStatus: "workflow-pending",
      runtimeChecks: required.map(
        (option) =>
          `pending required transition ${option.transitionId} -> ${option.agent} (${option.description})`,
      ),
      verifyRuns: [],
      reviewFindings: [],
      contract: "valid",
    },
  };
}
