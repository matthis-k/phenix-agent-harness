import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import { runId } from "../domain/shared.ts";
import {
  type NativeRunTranscript,
  NativeTranscriptComponent,
  readyNativeRunTranscript,
} from "../extension/native-run-transcript.ts";
import {
  subscribeCoalescedSource,
  WorkspaceControllerAdapter,
} from "../extension/workspace/workspace-controller-adapter.ts";
import type { PhenixWorkspaceSnapshot } from "../extension/workspace/workspace-model.ts";
import type { LoadedWorkspaceTranscript } from "../ports/workspace-effects.ts";

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
    sourceRefreshIntervalMs: 0,
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

test("transcript refresh retains the visible child until its replacement is ready", async () => {
  let current = snapshot(1);
  let publish = (): void => undefined;
  const first = nativeTranscript("child-first");
  const replacement = nativeTranscript("child-replacement");
  let resolveReplacement: (value: LoadedWorkspaceTranscript<NativeRunTranscript>) => void = () =>
    undefined;
  let loadCount = 0;
  const pendingReplacement = new Promise<LoadedWorkspaceTranscript<NativeRunTranscript>>(
    (resolve) => {
      resolveReplacement = resolve;
    },
  );
  const adapter = new WorkspaceControllerAdapter({
    snapshot: current,
    load: async () => current,
    loadTranscript: async () => {
      loadCount += 1;
      return loadCount === 1 ? readyNativeRunTranscript(first, "child-first") : pendingReplacement;
    },
    subscribe: (listener) => {
      publish = listener;
      return () => undefined;
    },
    sourceRefreshIntervalMs: 0,
    onChange: () => undefined,
  });

  adapter.selectTranscript(CHILD);
  await adapter.whenIdle();
  assert.equal(adapter.transcript, first);

  current = snapshot(2);
  publish();
  await eventually(() => adapter.state.transcript.availability.kind === "pending");
  assert.equal(adapter.transcript, first);

  resolveReplacement(readyNativeRunTranscript(replacement, "child-replacement"));
  await adapter.whenIdle();
  assert.equal(adapter.transcript, replacement);
  adapter.dispose();
});

test("coalesces repeated source events into one refresh window", async () => {
  let publish = (): void => undefined;
  let refreshes = 0;
  const unsubscribe = subscribeCoalescedSource(
    (listener) => {
      publish = listener;
      return () => undefined;
    },
    () => {
      refreshes += 1;
    },
    5,
  );

  publish();
  publish();
  publish();
  assert.equal(refreshes, 0);
  await eventually(() => refreshes === 1);

  publish();
  publish();
  await eventually(() => refreshes === 2);
  unsubscribe();
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
    rootTranscript: readyNativeRunTranscript(
      nativeTranscript(`root-${sequence}`),
      `root-${sequence}`,
    ),
  } as unknown as PhenixWorkspaceSnapshot;
}

function nativeTranscript(sessionId = "root-session"): NativeRunTranscript {
  return {
    component: new NativeTranscriptComponent(),
    sessionId,
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

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}
