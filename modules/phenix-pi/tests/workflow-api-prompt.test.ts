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
      sourceNodeId: "planning",
      targetNodeId: "planning",
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

describe("workflow authority prompt projection", () => {
  it("preloads target agents and the inspect/spawn protocol without private identities", () => {
    const prompt = formatWorkflowProjection(projection);

    assert.match(prompt, /resolved by the runtime before this agent started/i);
    assert.match(prompt, /Current node: planning/);
    assert.match(prompt, /Agent: architect/);
    assert.match(prompt, /Execution role: architect/);
    assert.match(prompt, /action=inspect/);
    assert.match(prompt, /action=spawn/);
    assert.match(prompt, /unique legal transition/i);
    assert.match(prompt, /never send a node ID back to the runtime/i);
    assert.doesNotMatch(prompt, /planner\.request-architect/);
    assert.doesNotMatch(prompt, /edgeId/);
    assert.doesNotMatch(prompt, /phenix_create_subagent/);
    assert.doesNotMatch(prompt, /Authority digest:/);
  });

  it("states deterministic no-target authority for a root actor", () => {
    const prompt = formatWorkflowProjection({ ...projection, options: [] });

    assert.match(prompt, /permits no target agent to be spawned/i);
    assert.match(prompt, /complete the current assignment directly/i);
    assert.doesNotMatch(prompt, /phenix_complete/);
  });

  it("uses the child completion protocol for contract-bound sessions", () => {
    const prompt = formatWorkflowProjection(
      { ...projection, options: [] },
      { completion: "phenix_complete" },
    );

    assert.match(prompt, /complete the current assignment directly using phenix_complete/i);
  });
});
