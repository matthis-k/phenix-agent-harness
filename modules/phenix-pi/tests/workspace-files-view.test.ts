import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import type { RunFact } from "../domain/run/observability.ts";
import type { RunId } from "../domain/shared.ts";
import { filesWorkspaceView } from "../extension/workspace/views/files-view.ts";
import {
  type PhenixWorkspaceSnapshot,
  projectWorkspaceFiles,
  workspaceItemIndex,
} from "../extension/workspace/workspace-model.ts";

test("accumulates unique modified files across the root run subtree", () => {
  const snapshot = fileSnapshot();
  const rows = projectWorkspaceFiles(snapshot);

  assert.deepEqual(
    rows.map((row) => row.path),
    ["README.md", "src/a.ts", "src/b.ts", "src/c.ts"],
  );
  const repeated = rows.find((row) => row.path === "src/a.ts");
  assert.ok(repeated);
  assert.deepEqual(
    {
      ...repeated,
      runIds: repeated.runIds.map(String),
    },
    {
      id: "src/a.ts",
      path: "src/a.ts",
      changeCount: 3,
      runIds: ["child", "grandchild"],
      latestSequence: 8,
      latestTimestamp: "2026-07-29T00:00:08Z",
      latestSummary: "Edited src/a.ts again",
    },
  );
  assert.deepEqual(workspaceItemIndex(snapshot).files, [
    "README.md",
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
  ]);
});

test("scopes accumulated files to the selected run and its descendants", () => {
  const snapshot = fileSnapshot();
  const selectedRunId = runId("child");

  assert.deepEqual(
    projectWorkspaceFiles(snapshot, selectedRunId).map((row) => row.path),
    ["src/a.ts", "src/b.ts"],
  );
  assert.deepEqual(
    filesWorkspaceView.project(snapshot, { selectedRunId }).map((row) => row.id),
    ["src/a.ts", "src/b.ts"],
  );
});

test("contains stale selection and non-file facts inside an empty projection", () => {
  const snapshot = fileSnapshot();
  assert.deepEqual(projectWorkspaceFiles(snapshot, runId("missing")), []);
});

function fileSnapshot(): PhenixWorkspaceSnapshot {
  const grandchild = runNode("grandchild");
  const child = runNode("child", [grandchild]);
  const sibling = runNode("sibling");
  const root = runNode("root", [child, sibling], "root");
  const facts = [
    fileFact(8, "child", "src/a.ts", "Edited src/a.ts again"),
    fileFact(2, "child", "src/a.ts", "Edited src/a.ts"),
    fileFact(1, "root", "README.md", "Edited README.md"),
    fileFact(5, "sibling", "src/c.ts", "Wrote src/c.ts"),
    fileFact(3, "grandchild", "src/a.ts", "Wrote src/a.ts"),
    fileFact(4, "child", "src/b.ts", "Edited src/b.ts"),
    fact(6, "child", "file-read", "src/ignored.ts"),
    fact(7, "child", "file-changed"),
  ];
  return {
    ui: {
      tree: { root },
      facts,
    },
    tasks: { root: {} },
    rootTranscript: {},
  } as unknown as PhenixWorkspaceSnapshot;
}

function runNode(
  id: string,
  children: readonly RunTreeNode[] = [],
  kind: RunSnapshot["kind"] = "agent",
): RunTreeNode {
  return {
    run: {
      id: runId(id),
      kind,
      state: "running",
      definitionId: kind === "root" ? "session.root" : "agent.test",
    } as RunSnapshot,
    children,
  };
}

function fileFact(sequence: number, owner: string, subject: string, summary: string): RunFact {
  return fact(sequence, owner, "file-changed", subject, summary);
}

function fact(
  sequence: number,
  owner: string,
  kind: RunFact["kind"],
  subject?: string,
  summary = `${kind} ${subject ?? "without subject"}`,
): RunFact {
  return {
    id: `fact-${sequence}`,
    rootRunId: runId("root"),
    runId: runId(owner),
    sequence,
    timestamp: `2026-07-29T00:00:${String(sequence).padStart(2, "0")}Z`,
    kind,
    source: "tool",
    summary,
    ...(subject ? { subject } : {}),
    provenance: {},
    reliability: "observed",
  };
}

function runId(value: string): RunId {
  return value as RunId;
}
