import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PHENIX_DEFAULT_WORKFLOW } from "@matthis-k/phenix-flow/workflow-definitions.ts";
import {
  targetAgentForTransition,
  validateTargetAgentDeterminism,
} from "@matthis-k/phenix-flow/workflow-target-agents.ts";
import type {
  DelegateTransition,
  WorkflowDefinition,
} from "@matthis-k/phenix-flow/workflow-types.ts";
import { mkTransitionId } from "@matthis-k/phenix-flow/workflow-types.ts";

function delegate(id: string): DelegateTransition {
  const transition = PHENIX_DEFAULT_WORKFLOW.transitions.find(
    (candidate): candidate is DelegateTransition =>
      candidate.kind === "delegate" && candidate.id === "planner.request-scout",
  );
  assert.ok(transition);
  return { ...transition, id: mkTransitionId(id) };
}

describe("workflow target-agent identities", () => {
  it("keeps the bundled workflow deterministic", () => {
    assert.deepEqual(validateTargetAgentDeterminism(PHENIX_DEFAULT_WORKFLOW), []);
  });

  it("specializes parallel D3 scouts while preserving the shared scout client", () => {
    const targets = PHENIX_DEFAULT_WORKFLOW.transitions
      .filter(
        (transition): transition is DelegateTransition =>
          transition.kind === "delegate" && transition.id.startsWith("d3.scout-"),
      )
      .map((transition) => ({
        target: targetAgentForTransition(transition),
        client: transition.agentClient.id,
      }))
      .sort((left, right) => left.target.localeCompare(right.target));

    assert.deepEqual(targets, [
      { target: "constraint-scout", client: "scout" },
      { target: "repository-scout", client: "scout" },
      { target: "test-scout", client: "scout" },
    ]);
  });

  it("rejects overlapping transitions with the same target agent", () => {
    const left = delegate("test.duplicate-scout-a");
    const right = delegate("test.duplicate-scout-b");
    const definition: WorkflowDefinition = {
      ...PHENIX_DEFAULT_WORKFLOW,
      transitions: [left, right],
    };

    const errors = validateTargetAgentDeterminism(definition);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /Ambiguous workflow target agent "scout"/);
  });
});
