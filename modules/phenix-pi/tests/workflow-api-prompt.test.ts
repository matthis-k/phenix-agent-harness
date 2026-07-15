import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatWorkflowProjection } from "../extensions/phenix-workflow/workflow-projection.ts";

const projection = {
  difficulty: "D2" as const,
  currentState: "planning",
  revision: 4,
  optionsDigest: "b".repeat(64),
  options: [
    {
      transitionId: "delegate-architect",
      workflowRevision: 4,
      role: "architect",
      purpose: "design",
      description: "Design the required boundary.",
      category: "required" as const,
      outputSchemaId: "architecture-result" as never,
      allowedModes: ["await" as const],
      resultSchema: { type: "object" },
    },
  ],
};

describe("workflow API prompt projection", () => {
  it("instructs Phenix models to inspect and create through the workflow API", () => {
    const prompt = formatWorkflowProjection(projection);

    assert.match(prompt, /phenix_workflow/);
    assert.match(prompt, /phenix_create_subagent/);
    assert.match(prompt, /runtime injects the current workflow revision and authority digest/i);
    assert.doesNotMatch(prompt, /Call phenix_delegate/);
    assert.doesNotMatch(prompt, /Authority digest:/);
  });

  it("states deterministic no-create authority when no transition is legal", () => {
    const prompt = formatWorkflowProjection({ ...projection, options: [] });

    assert.match(prompt, /No subagent creation transition is currently legal/);
    assert.match(prompt, /phenix_workflow/);
  });
});
