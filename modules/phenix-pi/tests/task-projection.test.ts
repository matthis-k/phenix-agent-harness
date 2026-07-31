import assert from "node:assert/strict";
import test from "node:test";

import { WORKFLOW_IMPLEMENT } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { TaskNode } from "../domain/task/projection.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("tasks form an independent hierarchy with many-to-many run assignments", async () => {
  const runtime = await createTestRuntime();
  const first = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_IMPLEMENT),
    input: { objective: "Implement first part" },
    wait: "await",
  });
  const second = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_IMPLEMENT),
    input: { objective: "Implement second part" },
    wait: "await",
  });
  await Promise.all([first.result(), second.result()]);

  const goal = await runtime.tasks.addLocal({
    ownerRunId: runtime.rootRunId,
    title: "Ship workspace improvements",
  });
  const child = await runtime.tasks.addLocal({
    ownerRunId: first.id,
    parentTaskId: goal.id,
    title: "Verify interaction details",
  });
  await runtime.tasks.assignRun(goal.id, first.id);
  await runtime.tasks.assignRun(goal.id, second.id);
  await runtime.tasks.assignRun(child.id, second.id);

  const tree = await runtime.tasks.tree(runtime.rootRunId);
  const flattened = flatten(tree.root);
  const executionTasks = flattened.filter((task) => task.kind === "execution");
  assert.deepEqual(executionTasks.map((task) => task.runId), [runtime.rootRunId]);

  const goalNode = flattened.find((task) => task.id === goal.id);
  assert.ok(goalNode?.kind === "local");
  assert.deepEqual(goalNode.children.map((task) => task.id), [child.id]);
  assert.deepEqual(
    goalNode.assignedRuns.map((assignment) => assignment.runId),
    [first.id, second.id],
  );

  const childNode = flattened.find((task) => task.id === child.id);
  assert.ok(childNode?.kind === "local");
  assert.deepEqual(childNode.assignedRuns.map((assignment) => assignment.runId), [second.id]);

  const secondTasks = await runtime.tasks.tasksFor(second.id);
  assert.deepEqual(
    secondTasks.map((task) => task.id),
    [goal.id, child.id],
  );
});

function flatten(root: TaskNode): TaskNode[] {
  const output: TaskNode[] = [root];
  for (const child of root.children) output.push(...flatten(child));
  return output;
}
