import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateDefinition } from "@matthis-k/phenix-suite/defaults/workflow.ts";
import {
  DEFAULT_WORKFLOWS,
  PHENIX_GENERAL_WORKFLOW,
  PHENIX_IMPLEMENT_WORKFLOW,
  PHENIX_QA_WORKFLOW,
} from "@matthis-k/phenix-suite/defaults/workflow-presets.ts";

function delegate(id: string, workflow = PHENIX_QA_WORKFLOW) {
  const transition = workflow.transitions.find((candidate) => candidate.id === id);
  assert.ok(transition, `${id} exists`);
  assert.equal(transition.kind, "delegate");
  if (transition.kind !== "delegate") throw new Error(`${id} is not a delegate transition`);
  return transition;
}

describe("workflow presets", () => {
  it("registers general, implementation, and QA definitions", () => {
    assert.deepEqual(
      DEFAULT_WORKFLOWS.map((workflow) => workflow.id),
      [PHENIX_GENERAL_WORKFLOW.id, PHENIX_IMPLEMENT_WORKFLOW.id, PHENIX_QA_WORKFLOW.id],
    );
    for (const workflow of DEFAULT_WORKFLOWS) {
      assert.deepEqual(validateDefinition(workflow), []);
    }
  });

  it("keeps the existing graph as the implementation preset", () => {
    assert.equal(PHENIX_IMPLEMENT_WORKFLOW.id, "phenix-default");
    assert.ok(
      PHENIX_IMPLEMENT_WORKFLOW.transitions.some((transition) => transition.id === "d3.implement"),
    );
  });

  it("gives general tasks a managed implementation escape hatch", () => {
    const root = delegate("general.execute", PHENIX_GENERAL_WORKFLOW);
    assert.equal(root.scope, "root");
    assert.equal(root.category, "required");
    assert.equal(root.agentClient.id, "base");

    const implementation = delegate("general.request-implementer", PHENIX_GENERAL_WORKFLOW);
    assert.equal(implementation.scope, "child");
    assert.equal(implementation.category, "optional");
    assert.equal(implementation.agentClient.id, "implementer");
    assert.ok(implementation.actorRoles.includes("base"));
  });

  it("enforces the QA specialist chain in workflow state", () => {
    const root = delegate("qa.integrate");
    assert.equal(root.scope, "root");
    assert.equal(root.agentClient.id, "base");
    assert.equal(root.category, "required");

    const expected = [
      ["qa.scout", "executing", "qa-evidence-ready", "scout"],
      ["qa.test", "qa-evidence-ready", "qa-tests-ready", "tester"],
      ["qa.architecture", "qa-tests-ready", "qa-architecture-ready", "architect"],
      ["qa.critic", "qa-architecture-ready", "qa-review-ready", "critic"],
    ] as const;

    for (const [id, from, next, role] of expected) {
      const transition = delegate(id);
      assert.equal(transition.scope, "child");
      assert.equal(transition.category, "required");
      assert.deepEqual(transition.from, [from]);
      assert.equal(transition.onAccepted, next);
      assert.equal(transition.onRejected, next);
      assert.equal(transition.agentClient.id, role);
      assert.deepEqual(transition.allowedModes, ["await"]);
      assert.equal(transition.maxExecutions, 1);
    }
  });
});
