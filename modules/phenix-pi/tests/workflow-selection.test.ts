import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  difficultyForWorkflow,
  selectWorkflow,
} from "@matthis-k/phenix-suite/composition/workflow-selection.ts";
import {
  PHENIX_GENERAL_WORKFLOW,
  PHENIX_IMPLEMENT_WORKFLOW,
  PHENIX_QA_WORKFLOW,
} from "@matthis-k/phenix-suite/defaults/workflow-presets.ts";

describe("workflow selection", () => {
  it("selects QA independently from generic task difficulty", () => {
    const workflow = selectWorkflow({
      userMessage: "do a full qa for this repo",
      fallbackWorkflowDefinitionId: PHENIX_GENERAL_WORKFLOW.id,
    });

    assert.equal(workflow.preset, "qa");
    assert.equal(workflow.workflowDefinitionId, PHENIX_QA_WORKFLOW.id);
    assert.equal(workflow.source, "classifier");
    assert.equal(
      difficultyForWorkflow({ selected: "D0", workflow, userMessage: "do a full qa for this repo" }),
      "D3",
    );
  });

  it("uses the implementation graph for code-change requests", () => {
    const workflow = selectWorkflow({
      userMessage: "fix the status projection and add regression tests",
      fallbackWorkflowDefinitionId: PHENIX_GENERAL_WORKFLOW.id,
    });

    assert.equal(workflow.preset, "implement");
    assert.equal(workflow.workflowDefinitionId, PHENIX_IMPLEMENT_WORKFLOW.id);
    assert.equal(difficultyForWorkflow({ selected: "D1", workflow, userMessage: "fix it" }), "D1");
  });

  it("uses general as the managed fallback for ambiguous follow-ups", () => {
    const workflow = selectWorkflow({
      userMessage: "go ahead",
      fallbackWorkflowDefinitionId: PHENIX_GENERAL_WORKFLOW.id,
    });

    assert.equal(workflow.preset, "general");
    assert.equal(workflow.source, "fallback");
  });

  it("honors an explicit per-turn preset before classification", () => {
    const workflow = selectWorkflow({
      userMessage: "workflow: general fix the issue directly",
      fallbackWorkflowDefinitionId: PHENIX_IMPLEMENT_WORKFLOW.id,
    });

    assert.equal(workflow.preset, "general");
    assert.equal(workflow.workflowDefinitionId, PHENIX_GENERAL_WORKFLOW.id);
    assert.equal(workflow.source, "explicit");
  });

  it("preserves a configured custom workflow as the fallback", () => {
    const workflow = selectWorkflow({
      userMessage: "continue",
      fallbackWorkflowDefinitionId: "custom-workflow",
    });

    assert.equal(workflow.workflowDefinitionId, "custom-workflow");
    assert.equal(workflow.source, "fallback");
  });
});
