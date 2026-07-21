import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelWorkflowProjection } from "@matthis-k/phenix-flow/workflow-projection.ts";
import {
  requiredWorkflowCompletionGate,
  WORKFLOW_REQUIRED_TRANSITION,
} from "@matthis-k/phenix-suite/subagents/workflow-completion-gate.ts";

function projection(category: "required" | "optional"): ModelWorkflowProjection {
  return {
    difficulty: "D3",
    currentState: "executing",
    revision: 0,
    optionsDigest: "digest",
    options: [
      {
        agent: "scout",
        transitionId: "qa.scout",
        sourceNodeId: "executing",
        targetNodeId: "qa-evidence-ready",
        workflowRevision: 0,
        role: "scout",
        purpose: "nested-evidence",
        description: "Inventory repository evidence",
        category,
        outputSchemaId: "scout-handoff" as never,
        allowedModes: ["await"],
        resultSchema: { type: "object" },
      },
    ],
  };
}

describe("required workflow completion gate", () => {
  it("rejects completion while a required child transition remains", () => {
    const result = requiredWorkflowCompletionGate(projection("required"));

    assert.equal(result?.ok, false);
    assert.equal(result?.summary.acceptanceStatus, "workflow-pending");
    assert.equal(result?.issues[0]?.code, WORKFLOW_REQUIRED_TRANSITION);
    assert.match(result?.issues[0]?.message ?? "", /phenix_workflow.*scout/i);
  });

  it("does not block completion for optional transitions", () => {
    assert.equal(requiredWorkflowCompletionGate(projection("optional")), undefined);
  });
});
