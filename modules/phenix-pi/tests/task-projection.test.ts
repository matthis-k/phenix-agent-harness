import assert from "node:assert/strict";
import test from "node:test";

import type { TaskNode } from "../domain/task/projection.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("tasks form an independent hierarchy with many-to-many run assignments", async () => {
  const runtime = await createTestRuntime();
  const goal = await runtime.tasks.addLocal({
    ownerRunId: runtime.rootRunId,
    title: "Ship workspace improvements",
  });
  const first = await runtime.dispatch.dispatch(runtime.rootRunId, {
    objective: "Implement first part",
    mode: "implement",
    wait: "background",
    taskIds: [goal.id],
  });
  const second = await runtime.dispatch.dispatch(runtime.rootRunId, {
    objective: "Implement second part",
    mode: "implement",
    wait: "background",
    taskIds: [goal.id],
  });
  await Promise.all([
    runtime.execution.await(first.runId),
    runtime.execution.await(second.runId),
  ]);

  const child = await runtime.tasks.addLocal({
    ownerRunId: first.runId,
    parentTaskId: goal.id,
    title: "Verify interaction details",
  });
  await runtime.tasks.assignRun(child.id, second.runId);

  const tree = await runtime.tasks.tree(runtime.rootRunId);
  const flattened = flatten(tree.root);
  const executionTasks = flattened.filter((task) => task.kind === "execution");
  assert.deepEqual(executionTasks.map((task) => task.runId), [runtime.rootRunId]);

  const goalNode = flattened.find((task) => task.id === goal.id);
  assert.ok(goalNode?.kind === "local");
  assert.deepEqual(goalNode.children.map((task) => task.id), [child.id]);
  assert.deepEqual(
    goalNode.assignedRuns.map((assignment) => assignment.runId),
    [first.runId, second.runId],
  );

  const childNode = flattened.find((task) => task.id === child.id);
  assert.ok(childNode?.kind === "local");
  assert.deepEqual(childNode.assignedRuns.map((assignment) => assignment.runId), [second.runId]);

  const secondTasks = await runtime.tasks.tasksFor(second.runId);
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
