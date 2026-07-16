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

describe("workflow authority prompt projection", () => {
  it("preloads legal edges without asking the model to report its node", () => {
    const prompt = formatWorkflowProjection(projection);

    assert.match(prompt, /resolved by the runtime before this agent started/i);
    assert.match(prompt, /Current node: planning/);
    assert.match(prompt, /Edge ID: planner\.request-architect/);
    assert.match(prompt, /Kind: spawn/);
    assert.match(prompt, /one advertised edgeId/i);
    assert.match(prompt, /runtime derives the current node/i);
    assert.match(prompt, /never send a node ID back to the runtime/i);
    assert.doesNotMatch(prompt, /action=inspect/);
    assert.doesNotMatch(prompt, /action=take/);
    assert.doesNotMatch(prompt, /phenix_create_subagent/);
    assert.doesNotMatch(prompt, /Authority digest:/);
  });

  it("states deterministic no-edge authority", () => {
    const prompt = formatWorkflowProjection({ ...projection, options: [] });

    assert.match(prompt, /no legal outgoing spawn edge/i);
    assert.match(prompt, /complete the current assignment directly/i);
    assert.doesNotMatch(prompt, /action=inspect/);
  });
});
