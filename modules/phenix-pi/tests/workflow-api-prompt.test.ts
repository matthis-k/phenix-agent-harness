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
      edgeId: "planner.request-architect",
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

describe("workflow API prompt projection", () => {
  it("instructs Phenix models to inspect a node and take an edge", () => {
    const prompt = formatWorkflowProjection(projection);

    assert.match(prompt, /Current node ID: planning/);
    assert.match(prompt, /Edge ID: planner\.request-architect/);
    assert.match(prompt, /Kind: spawn/);
    assert.match(prompt, /action=inspect/);
    assert.match(prompt, /action=take/);
    assert.match(prompt, /nodeId/);
    assert.match(prompt, /edgeId/);
    assert.doesNotMatch(prompt, /phenix_create_subagent/);
    assert.doesNotMatch(prompt, /Authority digest:/);
  });

  it("states deterministic no-edge authority", () => {
    const prompt = formatWorkflowProjection({ ...projection, options: [] });

    assert.match(prompt, /no legal outgoing spawn edge/i);
    assert.match(prompt, /action=inspect/);
  });
});
