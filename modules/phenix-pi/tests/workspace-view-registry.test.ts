import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import type { TaskNode } from "../domain/task/projection.ts";
import {
  type PhenixWorkspaceSnapshot,
  projectWorkspaceRuns,
  projectWorkspaceTasks,
  workspaceItemIndex,
} from "../extension/workspace/workspace-model.ts";
import { factsWorkspaceView } from "../extension/workspace/views/facts-view.ts";
import { filesWorkspaceView } from "../extension/workspace/views/files-view.ts";
import { runsWorkspaceView } from "../extension/workspace/views/runs-view.ts";
import { tasksWorkspaceView } from "../extension/workspace/views/tasks-view.ts";
import {
  createWorkspaceViewRegistry,
  workspaceViewRegistry,
} from "../extension/workspace/views/workspace-view-registry.ts";
import { WORKSPACE_VIEW_IDS } from "../extension/workspace/views/workspace-view.ts";

test("registers every independent workspace view in stable order", () => {
  assert.deepEqual(
    workspaceViewRegistry.ordered.map((view) => view.id),
    WORKSPACE_VIEW_IDS,
  );
  assert.equal(workspaceViewRegistry.get("runs"), runsWorkspaceView);
  assert.equal(workspaceViewRegistry.get("tasks"), tasksWorkspaceView);
  assert.equal(workspaceViewRegistry.get("files"), filesWorkspaceView);
  assert.equal(workspaceViewRegistry.get("facts"), factsWorkspaceView);
});

test("rejects duplicate and incomplete workspace registries", () => {
  assert.throws(
    () =>
      createWorkspaceViewRegistry([
        runsWorkspaceView,
        runsWorkspaceView,
        tasksWorkspaceView,
        filesWorkspaceView,
        factsWorkspaceView,
      ]),
    /runs is registered more than once/,
  );
  assert.throws(
    () =>
      createWorkspaceViewRegistry([
        runsWorkspaceView,
        tasksWorkspaceView,
        filesWorkspaceView,
      ]),
    /missing: facts/,
  );
});

test("view projections preserve run and task collapse semantics", () => {
  const hiddenRun = runNode("hidden", "running");
  const completedRun = runNode("completed", "completed", [hiddenRun]);
  const activeRun = runNode("active", "running");
  const rootRun = runNode("root", "running", [completedRun, activeRun], "root");
  assert.deepEqual(
    projectWorkspaceRuns(rootRun).map((row) => [String(row.node.run.id), row.depth]),
    [
      ["root", 0],
      ["completed", 1],
      ["active", 1],
    ],
  );

  const hiddenTask = taskNode("hidden-task", "wip");
  const completedTask = taskNode("completed-task", "done", [hiddenTask]);
  const activeTask = taskNode("active-task", "wip");
  const rootTask = taskNode("root-task", "wip", [completedTask, activeTask]);
  assert.deepEqual(
    projectWorkspaceTasks(rootTask).map((row) => [row.node.id, row.depth]),
    [
      ["completed-task", 0],
      ["active-task", 0],
    ],
  );
});

test("derives pane item identity exclusively from registered projections", () => {
  const snapshot = {
    ui: {
      tree: {
        root: runNode("root", "running", [runNode("child", "running")], "root"),
      },
      facts: [
        { id: "fact-old", timestamp: "2026-07-28T10:00:00Z", summary: "old" },
        { id: "fact-new", timestamp: "2026-07-28T11:00:00Z", summary: "new" },
      ],
    },
    tasks: {
      root: taskNode("root-task", "wip", [taskNode("task-child", "wip")]),
    },
    rootTranscript: {},
  } as unknown as PhenixWorkspaceSnapshot;

  assert.deepEqual(workspaceItemIndex(snapshot), {
    transcript: [],
    editor: [],
    runs: ["root", "child"],
    tasks: ["task-child"],
    files: [],
    facts: ["fact-new", "fact-old"],
  });
  assert.deepEqual(workspaceViewRegistry.get("files").project(snapshot), []);
});

function runNode(
  id: string,
  state: RunSnapshot["state"],
  children: readonly RunTreeNode[] = [],
  kind: RunSnapshot["kind"] = "agent",
): RunTreeNode {
  return {
    run: {
      id,
      kind,
      state,
      definitionId: kind === "root" ? "session.root" : "agent.test",
    } as RunSnapshot,
    children,
  };
}

function taskNode(
  id: string,
  effectiveState: TaskNode["effectiveState"],
  children: TaskNode[] = [],
): TaskNode {
  return {
    kind: "execution",
    id,
    runId: id,
    title: id,
    ownState: effectiveState,
    effectiveState,
    progress: [],
    children,
  } as unknown as TaskNode;
}
