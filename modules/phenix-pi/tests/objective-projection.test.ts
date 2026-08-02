import assert from "node:assert/strict";
import test from "node:test";

import { WORKFLOW_IMPLEMENT } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("delegations do not become objectives and descendants inherit objective focus", async () => {
  const runtime = await createTestRuntime();

  const first = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_IMPLEMENT),
    input: { objective: "Operational delegation before objective tracking" },
    wait: "await",
  });
  await first.result();
  assert.deepEqual((await runtime.objectives.tree(runtime.rootRunId)).roots, []);

  const objective = await runtime.objectives.add({
    actorRunId: runtime.rootRunId,
    title: "Ship objective tracking",
  });
  const second = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_IMPLEMENT),
    input: { objective: "Implement one part of the tracked outcome" },
    wait: "await",
  });
  await second.result();

  const tree = await runtime.objectives.tree(runtime.rootRunId);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]?.id, objective.id);
  assert.equal(tree.focusByRun[String(runtime.rootRunId)]?.id, objective.id);
  assert.equal(tree.focusByRun[String(second.id)]?.id, objective.id);
  assert.equal(tree.roots[0]?.children.length, 0);
});

test("discovered sub-objectives are independent from run ancestry and gate parent completion", async () => {
  const runtime = await createTestRuntime();
  const parent = await runtime.objectives.add({
    actorRunId: runtime.rootRunId,
    title: "Support all relevant edge cases",
  });
  const worker = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_IMPLEMENT),
    input: { objective: "Exercise the main implementation path" },
    wait: "await",
  });
  await worker.result();

  const edgeCase = await runtime.objectives.add({
    actorRunId: worker.id,
    parentObjectiveId: parent.id,
    title: "Handle empty routing tables",
    description: "Discovered when the edge-case check failed.",
    focus: false,
  });
  assert.equal(edgeCase.source, "discovered");

  await runtime.objectives.setState(runtime.rootRunId, parent.id, "done");
  let tree = await runtime.objectives.tree(runtime.rootRunId);
  assert.equal(tree.roots[0]?.state, "done");
  assert.equal(tree.roots[0]?.effectiveState, "wip");
  assert.equal(tree.roots[0]?.children[0]?.id, edgeCase.id);

  await runtime.objectives.setState(runtime.rootRunId, edgeCase.id, "blocked");
  tree = await runtime.objectives.tree(runtime.rootRunId);
  assert.equal(tree.roots[0]?.effectiveState, "blocked");

  await runtime.objectives.setState(runtime.rootRunId, edgeCase.id, "done");
  tree = await runtime.objectives.tree(runtime.rootRunId);
  assert.equal(tree.roots[0]?.effectiveState, "done");
  assert.equal(tree.roots[0]?.children[0]?.effectiveState, "done");
});
