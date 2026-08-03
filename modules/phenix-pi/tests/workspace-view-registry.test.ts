import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { ObjectiveNode } from "../domain/objective/projection.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import type { ObservabilityTheme } from "../extension/observability-theme.ts";
import { factsWorkspaceView } from "../extension/workspace/views/facts-view.ts";
import { filesWorkspaceView } from "../extension/workspace/views/files-view.ts";
import { memoryWorkspaceView } from "../extension/workspace/views/memory-view.ts";
import { objectivesWorkspaceView } from "../extension/workspace/views/objectives-view.ts";
import { runsWorkspaceView } from "../extension/workspace/views/runs-view.ts";
import { WORKSPACE_VIEW_IDS } from "../extension/workspace/views/workspace-view.ts";
import {
  createWorkspaceViewRegistry,
  workspaceViewRegistry,
} from "../extension/workspace/views/workspace-view-registry.ts";
import {
  type PhenixWorkspaceSnapshot,
  projectWorkspaceObjectives,
  projectWorkspaceRuns,
  workspaceItemIndex,
} from "../extension/workspace/workspace-model.ts";

const THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ObservabilityTheme;

test("registers every independent workspace view in stable order", () => {
  assert.deepEqual(
    workspaceViewRegistry.ordered.map((view) => view.id),
    WORKSPACE_VIEW_IDS,
  );
  assert.equal(workspaceViewRegistry.get("runs"), runsWorkspaceView);
  assert.equal(workspaceViewRegistry.get("objectives"), objectivesWorkspaceView);
  assert.equal(workspaceViewRegistry.get("memory"), memoryWorkspaceView);
  assert.equal(workspaceViewRegistry.get("files"), filesWorkspaceView);
  assert.equal(workspaceViewRegistry.get("facts"), factsWorkspaceView);
});

test("rejects duplicate and incomplete workspace registries", () => {
  assert.throws(
    () =>
      createWorkspaceViewRegistry([
        runsWorkspaceView,
        runsWorkspaceView,
        objectivesWorkspaceView,
        memoryWorkspaceView,
        filesWorkspaceView,
        factsWorkspaceView,
      ]),
    /runs is registered more than once/,
  );
  assert.throws(
    () =>
      createWorkspaceViewRegistry([
        runsWorkspaceView,
        objectivesWorkspaceView,
        memoryWorkspaceView,
        filesWorkspaceView,
      ]),
    /missing: facts/,
  );
});

test("view projections preserve run and objective collapse semantics", () => {
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

  const hiddenObjective = objectiveNode("hidden-objective", "wip");
  const completedObjective = objectiveNode("completed-objective", "done", [hiddenObjective]);
  const activeObjective = objectiveNode("active-objective", "wip");
  assert.deepEqual(
    projectWorkspaceObjectives([completedObjective, activeObjective]).map((row) => [
      row.node.id,
      row.depth,
    ]),
    [
      ["completed-objective", 0],
      ["active-objective", 0],
    ],
  );
});

test("run rows disclose model profile and session metadata only when expanded", () => {
  const baseRoot = runNode("root", "running", [], "root");
  const root = {
    ...baseRoot,
    run: {
      ...baseRoot.run,
      profile: { agent: "base", modelSet: "free", difficulty: "D1", budget: "high" },
      pi: { sessionId: "session-123" },
    } as unknown as RunSnapshot,
  } satisfies RunTreeNode;
  const snapshot = workspaceSnapshot(root);
  const row = runsWorkspaceView.project(snapshot)[0];
  assert.ok(row?.expandable);

  const collapsed = row.render({
    theme: THEME,
    width: 120,
    activeRunId: root.run.id,
    expanded: false,
  }).text;
  assert.doesNotMatch(collapsed, /free|budget-high|session-123|D1/);

  const expanded = row.render({
    theme: THEME,
    width: 120,
    activeRunId: root.run.id,
    expanded: true,
  }).text;
  assert.match(expanded, /free\/budget-high/);
  assert.match(expanded, /session session-123/);
});

test("agent session rows show their own difficulty and focused objective while collapsed", () => {
  const childBase = runNode("child", "running");
  const child = {
    ...childBase,
    run: {
      ...childBase.run,
      compiled: { ...childBase.run.compiled, difficulty: "D2", budget: "high" },
    } as unknown as RunSnapshot,
  } satisfies RunTreeNode;
  const root = runNode("root", "running", [child], "root");
  const objective = objectiveNode(
    "objective-main",
    "wip",
    [],
    [{ runId: child.run.id, model: "phenix/mixed" }],
  );
  const snapshot = workspaceSnapshot(root, [objective], {
    child: {
      id: objective.id,
      title: objective.title,
      state: objective.state,
      effectiveState: objective.effectiveState,
    },
  });
  const row = runsWorkspaceView.project(snapshot).find((candidate) => candidate.id === "child");
  assert.ok(row);

  const collapsed = row.render({
    theme: THEME,
    width: 120,
    activeRunId: root.run.id,
    expanded: false,
  }).text;
  assert.match(collapsed, /D2/);
  assert.match(collapsed, /Ship objective tracking/);
  assert.doesNotMatch(collapsed, /budget high/);
});

test("run rows surface normal and urgent input requirements", () => {
  const root = runNode(
    "root",
    "running",
    [runNode("normal", "running"), runNode("urgent", "running")],
    "root",
  );
  const snapshot = {
    ...workspaceSnapshot(root),
    attentionByRun: {
      normal: { kind: "input-required", count: 1, urgent: false },
      urgent: { kind: "input-required", count: 2, urgent: true },
    },
  } as unknown as PhenixWorkspaceSnapshot;
  const rows = runsWorkspaceView.project(snapshot);
  const normal = rows.find((row) => row.id === "normal");
  const urgent = rows.find((row) => row.id === "urgent");
  assert.ok(normal);
  assert.ok(urgent);

  assert.match(
    normal.render({
      theme: THEME,
      width: 120,
      activeRunId: root.run.id,
      expanded: false,
    }).text,
    /INPUT REQUIRED/,
  );
  assert.match(
    urgent.render({
      theme: THEME,
      width: 120,
      activeRunId: root.run.id,
      expanded: false,
    }).text,
    /URGENT INPUT ×2/,
  );
});

test("derives pane identity and row behavior exclusively from registered projections", () => {
  const root = runNode("root", "running", [runNode("child", "running")], "root");
  const objective = objectiveNode("objective-main", "wip", [
    objectiveNode("objective-child", "wip"),
  ]);
  const snapshot = {
    ...workspaceSnapshot(root, [objective]),
    ui: {
      tree: { root },
      facts: [
        {
          id: "fact-old",
          timestamp: "2026-07-28T10:00:00Z",
          runId: "root",
          summary: "old",
        },
        {
          id: "fact-file",
          timestamp: "2026-07-28T10:30:00Z",
          runId: "child",
          kind: "file-changed",
          subject: "README.md",
          summary: "Changed README.md",
          sequence: 2,
        },
        {
          id: "fact-new",
          timestamp: "2026-07-28T11:00:00Z",
          runId: "root",
          summary: "new",
        },
      ],
    },
    memory: {
      rootRunId: "root",
      evidence: [],
      notes: [
        {
          id: "memory-new",
          rootRunId: "root",
          runId: "child",
          objectiveIds: [],
          kind: "decision",
          status: "active",
          retention: "must-retain",
          reliability: "reported",
          summary: "Use reversible evidence",
          evidenceIds: [],
          createdAt: "2026-07-28T11:30:00Z",
          updatedAt: "2026-07-28T11:30:00Z",
        },
      ],
      stats: { evidenceCount: 0, activeNoteCount: 1, storedBytes: 0 },
    },
    rootTranscript: {},
  } as unknown as PhenixWorkspaceSnapshot;

  assert.deepEqual(workspaceItemIndex(snapshot), {
    transcript: [],
    editor: [],
    runs: ["root", "child"],
    objectives: ["objective-main", "objective-child"],
    memory: ["memory-new"],
    files: ["README.md"],
    facts: ["fact-new", "fact-file", "fact-old"],
  });
  for (const view of workspaceViewRegistry.ordered) {
    for (const row of view.project(snapshot)) {
      assert.equal(typeof row.render, "function");
    }
  }
  assert.equal(
    workspaceViewRegistry.get("runs").project(snapshot)[0]?.activation?.kind,
    "transcript",
  );
  assert.equal(
    workspaceViewRegistry.get("facts").project(snapshot)[0]?.activation?.kind,
    "inspector",
  );
});

function workspaceSnapshot(
  root: RunTreeNode,
  objectives: readonly ObjectiveNode[] = [],
  focusByRun: Readonly<Record<string, unknown>> = {},
): PhenixWorkspaceSnapshot {
  return {
    ui: { tree: { root }, facts: [] },
    objectives: { roots: objectives, focusByRun },
  } as unknown as PhenixWorkspaceSnapshot;
}

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
      compiled: {
        definitionId: kind === "root" ? "session.root" : "agent.test",
        input: {},
        outputSchemaId: "test.output",
        tools: [],
        limits: { timeoutMs: 60_000 },
        capabilities: {
          invokableDefinitions: [],
          maxDepth: 1,
          mayDetach: false,
          maySend: false,
          mayCancelChildren: false,
        },
        invocation: { wait: "await" },
      },
    } as unknown as RunSnapshot,
    children,
  };
}

function objectiveNode(
  id: string,
  effectiveState: ObjectiveNode["effectiveState"],
  children: ObjectiveNode[] = [],
  workers: ObjectiveNode["workers"] = [],
): ObjectiveNode {
  return {
    id,
    rootRunId: "root",
    createdByRunId: "root",
    title: id === "objective-main" ? "Ship objective tracking" : id,
    source: id.includes("child") ? "discovered" : "user",
    state: effectiveState,
    effectiveState,
    createdAt: "2026-07-28T10:00:00Z",
    updatedAt: "2026-07-28T10:00:00Z",
    progress: [],
    workers,
    children,
  } as unknown as ObjectiveNode;
}
