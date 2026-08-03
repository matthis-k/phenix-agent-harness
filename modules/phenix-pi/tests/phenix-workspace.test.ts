import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { ObjectiveNode } from "../domain/objective/projection.ts";
import {
  allocateWorkspaceSections,
  computeWorkspaceLayout,
  flattenWorkspaceObjectives,
  flattenWorkspaceRuns,
} from "../extension/phenix-workspace.ts";

const EXPANDED_SECTIONS = {
  runs: false,
  objectives: false,
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
    objectives: 5,
    files: 7,
    facts: 7,
  });
  assert.deepEqual(allocateWorkspaceSections(30, { ...EXPANDED_SECTIONS, objectives: true }), {
    runs: 12,
    objectives: 2,
    files: 8,
    facts: 8,
  });
  for (let height = 0; height <= 10; height += 1) {
    const allocated = allocateWorkspaceSections(height, EXPANDED_SECTIONS);
    assert.ok(allocated.runs + allocated.objectives + allocated.files + allocated.facts <= height);
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

test("keeps active objective detail while collapsing completed objective subtrees", () => {
  const roots = [
    objectiveNode("objective-active", "wip", [
      objectiveNode("objective-active-leaf", "not_started"),
    ]),
    objectiveNode("objective-done", "done", [objectiveNode("objective-done-leaf", "done")]),
  ];

  const flattened = flattenWorkspaceObjectives(roots) as ReadonlyArray<{
    readonly node: ObjectiveNode;
    readonly depth: number;
  }>;
  assert.deepEqual(
    flattened.map((item) => [item.node.id, item.depth]),
    [
      ["objective-active", 0],
      ["objective-active-leaf", 1],
      ["objective-done", 0],
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

function objectiveNode(
  id: string,
  effectiveState: "not_started" | "wip" | "done" | "blocked",
  children: readonly ObjectiveNode[] = [],
): ObjectiveNode {
  return {
    id,
    rootRunId: "root-session",
    createdByRunId: "root-session",
    title: id,
    source: "user",
    state: effectiveState,
    effectiveState,
    progress: [],
    workers: [],
    children,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  } as unknown as ObjectiveNode;
}
