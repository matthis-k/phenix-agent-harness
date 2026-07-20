import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveWorkflowAssignment } from "@matthis-k/phenix-suite/subagents/workflow-assignment.ts";

describe("workflow assignment policy", () => {
  it("binds required root execution to the complete user request", () => {
    const assignment = resolveWorkflowAssignment({
      source: "root",
      category: "required",
      transitionDescription: "Execute a bounded non-code task as a base agent",
      requestedTask: "Run only the QA skeleton command.",
      userTask: "Do a full QA pass on this repository.",
      requestedRequirements: ["Write results to qa-results."],
    });

    assert.match(assignment.task, /Execute a bounded non-code task/i);
    assert.match(assignment.task, /Do a full QA pass on this repository/i);
    assert.doesNotMatch(assignment.task, /Run only the QA skeleton command/i);
    assert.ok(
      assignment.requirements.some((requirement) => /entire user request/i.test(requirement)),
    );
    assert.ok(assignment.requirements.includes("Write results to qa-results."));
  });

  it("preserves model-owned scope for optional and contract-bound work", () => {
    for (const input of [
      { source: "root" as const, category: "optional" as const },
      { source: "contract" as const, category: "required" as const },
    ]) {
      const assignment = resolveWorkflowAssignment({
        ...input,
        transitionDescription: "Inspect evidence",
        requestedTask: "Inspect only the routing boundary.",
        userTask: "Review the whole repository.",
        requestedRequirements: ["Return evidence", "Return evidence"],
      });

      assert.equal(assignment.task, "Inspect only the routing boundary.");
      assert.deepEqual(assignment.requirements, ["Return evidence"]);
    }
  });
});
