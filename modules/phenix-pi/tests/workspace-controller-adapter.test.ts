import assert from "node:assert/strict";
import test from "node:test";

import { Container } from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import { runId } from "../domain/shared.ts";
import { readyNativeRunTranscript } from "../extension/native-run-transcript.ts";
import { WorkspaceControllerAdapter } from "../extension/workspace/workspace-controller-adapter.ts";
import type { PhenixWorkspaceSnapshot } from "../extension/workspace/workspace-model.ts";

const ROOT = runId("root");
const CHILD = runId("child");

test("snapshot refresh preserves a browsed run selection independently of the active transcript", async () => {
  let current = snapshot(1);
  let publish = (): void => undefined;
  const adapter = new WorkspaceControllerAdapter({
    snapshot: current,
    load: async () => current,
    loadTranscript: async () => readyNativeRunTranscript(nativeTranscript(), "child"),
    subscribe: (listener) => {
      publish = listener;
      return () => undefined;
    },
    onChange: () => undefined,
  });

  adapter.dispatch({ type: "selection.set", paneId: "runs", itemId: String(CHILD) });
  assert.equal(adapter.state.activeRunId, ROOT);
  assert.equal(adapter.state.panes.runs.selectedItemId, CHILD);

  current = snapshot(2);
  publish();
  await adapter.whenIdle();

  assert.equal(adapter.state.activeRunId, ROOT);
  assert.equal(adapter.state.panes.runs.selectedItemId, CHILD);
  adapter.dispose();
});

function snapshot(sequence: number): PhenixWorkspaceSnapshot {
  return {
    ui: {
      sequence,
      tree: {
        root: node(ROOT, "root", [node(CHILD, "agent")]),
      },
      facts: [],
      profile: { agent: "base", modelSet: "free", difficulty: "D1" },
      diagnostics: {
        total: 0,
        artifacts: 0,
        counts: { trace: 0, info: 0, warning: 0, error: 0 },
      },
      integrations: "ready",
      definitions: [],
    },
    tasks: {
      root: {
        kind: "execution",
        id: "root-task",
        runId: ROOT,
        title: "Root task",
        ownState: "wip",
        effectiveState: "wip",
        progress: [],
        children: [],
      },
    },
    rootTranscript: readyNativeRunTranscript(nativeTranscript(), `root-${sequence}`),
  } as unknown as PhenixWorkspaceSnapshot;
}

function nativeTranscript() {
  return {
    component: new Container(),
    sessionId: "root-session",
  };
}

function node(
  id: ReturnType<typeof runId>,
  kind: RunSnapshot["kind"],
  children: readonly RunTreeNode[] = [],
): RunTreeNode {
  return {
    run: {
      id,
      ...(kind === "agent" ? { parentId: ROOT } : {}),
      kind,
      definitionId: kind === "root" ? "session.root" : "agent.qa",
      state: "running",
    } as RunSnapshot,
    children,
  };
}
