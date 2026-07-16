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
      agent: "architect",
      transitionId: "planner.request-architect",
      workflowRevision: 4,
      role: "architect",
      purpose: "design",
      description: "Design the required boundary.",
      category: "required" as const,
      outputSchemaId: "architecture-handoff" as const,
      allowedModes: ["await" as const],
      resultSchema: { type: "object" },
    },
  ],
};

describe("workflow API prompt projection", () => {
  it("instructs Phenix models to use scoped workflow actions", () => {
    const prompt = formatWorkflowProjection(projection);

    assert.match(prompt, /phenix_workflow/);
    assert.match(prompt, /action=inspect/);
    assert.match(prompt, /action=delegate/);
    assert.match(prompt, /architect/);
    assert.match(prompt, /runtime resolves the local name/i);
    assert.doesNotMatch(prompt, /phenix_create_subagent/);
    assert.doesNotMatch(prompt, /planner\.request-architect/);
    assert.doesNotMatch(prompt, /Authority digest:/);
  });

  it("states deterministic no-delegation authority when no action is legal", () => {
    const prompt = formatWorkflowProjection({ ...projection, options: [] });

    assert.match(prompt, /No delegation action is currently legal/);
    assert.match(prompt, /action=inspect/);
  });
});
