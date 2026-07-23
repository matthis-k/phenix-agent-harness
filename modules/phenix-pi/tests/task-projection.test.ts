import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_IMPLEMENT } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { TaskNode } from "../domain/task/projection.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("task anchors are derived one-for-one from runs and local tasks are leaves", async () => {
  const runtime = await createTestRuntime();
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_IMPLEMENT),
    input: { objective: "Implement" },
    wait: "await",
  });
  await handle.result();
  const local = await runtime.tasks.addLocal({
    ownerRunId: handle.id,
    title: "Record release note",
  });
  await runtime.tasks.setLocalState(local.id, "done");

  const tree = await runtime.tasks.tree(runtime.rootRunId);
  const executionTasks = flatten(tree.root).filter((task) => task.kind === "execution");
  assert.equal(executionTasks.length, runtime.store.projection.runs.size);
  assert.deepEqual(
    new Set(executionTasks.map((task) => task.id)),
    new Set([...runtime.store.projection.runs.keys()].map((id) => `run:${id}`)),
  );
  const localNode = flatten(tree.root).find((task) => task.id === local.id);
  assert.ok(localNode);
  assert.equal(localNode.kind, "local");
  assert.deepEqual(localNode.children, []);
  assert.equal(localNode.effectiveState, "done");
});

function flatten(root: TaskNode): TaskNode[] {
  const output: TaskNode[] = [root];
  for (const child of root.children) output.push(...flatten(child));
  return output;
}
