import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { TaskNode } from "../domain/task/projection.ts";
import {
  allocateWorkspaceSections,
  computeWorkspaceLayout,
  flattenWorkspaceRuns,
  flattenWorkspaceTasks,
} from "../extension/phenix-workspace.ts";

const EXPANDED_SECTIONS = {
  runs: false,
  tasks: false,
  files: false,
  facts: false,
} as const;

test("gives the conversation most of the terminal while keeping an OpenCode-like sidebar", () => {
  assert.deepEqual(computeWorkspaceLayout(120, 40), {
    width: 120,
    height: 40,
    sidebarVisible: true,
    sidebarWidth: 28,
    mainWidth: 91,
  });
  assert.deepEqual(computeWorkspaceLayout(89, 40), {
    width: 89,
    height: 40,
    sidebarVisible: false,
    sidebarWidth: 0,
    mainWidth: 89,
  });
});

test("allocates every registered view as an independent scroll region", () => {
  assert.deepEqual(allocateWorkspaceSections(30, EXPANDED_SECTIONS), {
    runs: 11,
    tasks: 5,
    files: 7,
    facts: 7,
  });
  assert.deepEqual(allocateWorkspaceSections(30, { ...EXPANDED_SECTIONS, tasks: true }), {
    runs: 12,
    tasks: 2,
    files: 8,
    facts: 8,
  });
  for (let height = 0; height <= 10; height += 1) {
    const allocated = allocateWorkspaceSections(height, EXPANDED_SECTIONS);
    assert.ok(allocated.runs + allocated.tasks + allocated.files + allocated.facts <= height);
  }
});

test("keeps active run detail while collapsing completed subtrees", () => {
  const activeLeaf = runNode("run-active-leaf", "running");
  const completedLeaf = runNode("run-completed-leaf", "completed");
  const root = runNode(
    "root-session",
    "running",
    [
      runNode("run-active", "running", [activeLeaf]),
      runNode("run-completed", "completed", [completedLeaf]),
    ],
    "root",
  );

  const flattened = flattenWorkspaceRuns(root) as ReadonlyArray<{
    readonly node: RunTreeNode;
    readonly depth: number;
  }>;
  assert.equal(flattened[0]?.node.run.kind, "root");
  assert.deepEqual(
    flattened.map((item) => [String(item.node.run.id), item.depth]),
    [
      ["root-session", 0],
      ["run-active", 1],
      ["run-active-leaf", 2],
      ["run-completed", 1],
    ],
  );
});

test("keeps active task detail while collapsing completed task subtrees", () => {
  const root = taskNode("run:root", "wip", [
    taskNode("run:active", "wip", [taskNode("local:active-leaf", "not_started")]),
    taskNode("run:done", "done", [taskNode("local:done-leaf", "done")]),
  ]);

  const flattened = flattenWorkspaceTasks(root) as ReadonlyArray<{
    readonly node: TaskNode;
    readonly depth: number;
  }>;
  assert.deepEqual(
    flattened.map((item) => [item.node.id, item.depth]),
    [
      ["run:active", 0],
      ["local:active-leaf", 1],
      ["run:done", 0],
    ],
  );
});

function runNode(
  id: string,
  state: string,
  children: readonly RunTreeNode[] = [],
  kind: "root" | "agent" = "agent",
): RunTreeNode {
  return {
    run: {
      id,
      kind,
      definitionId: kind === "root" ? "session.root" : "agent.scout",
      state,
      requestedAt: "2026-07-28T00:00:00.000Z",
      activeChildren: [],
    },
    children,
  } as unknown as RunTreeNode;
}

function taskNode(
  id: string,
  effectiveState: "not_started" | "wip" | "done" | "failed",
  children: readonly TaskNode[] = [],
): TaskNode {
  return {
    kind: "execution",
    id,
    runId: id.replace(/^run:/, ""),
    title: id,
    ownState: effectiveState,
    effectiveState,
    progress: [],
    children,
  } as unknown as TaskNode;
}
