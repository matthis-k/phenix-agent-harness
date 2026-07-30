import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import { runsWorkspaceView } from "../application/workspace/views/runs-view.ts";
import type { WorkspaceViewSnapshot } from "../application/workspace/views/workspace-view.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import { runId } from "../domain/shared.ts";

const ANSI_ESCAPE_PREFIX = `${String.fromCharCode(27)}[`;
const HOST_NEUTRAL_MODULES = [
  "../application/workspace/frontend.ts",
  "../application/workspace/presentation.ts",
  "../application/workspace/views/facts-view.ts",
  "../application/workspace/views/files-view.ts",
  "../application/workspace/views/runs-view.ts",
  "../application/workspace/views/tasks-view.ts",
  "../application/workspace/views/workspace-view-format.ts",
  "../application/workspace/views/workspace-view-registry.ts",
  "../application/workspace/views/workspace-view.ts",
  "../domain/workspace/surfaces.ts",
] as const;

test("shared workspace frontend has no Pi or extension dependencies", async () => {
  for (const path of HOST_NEUTRAL_MODULES) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /@earendil-works\/pi-(?:tui|coding-agent)/, path);
    assert.doesNotMatch(source, /(?:^|\/)extension\//m, path);
  }
});

test("registered rows expose host-neutral semantic presentations", () => {
  const root = runNode("root", "running", "root");
  const snapshot = {
    ui: { tree: { root }, facts: [] },
    tasks: {
      root: {
        kind: "execution",
        id: "root-task",
        runId: root.run.id,
        title: "Root task",
        ownState: "wip",
        effectiveState: "wip",
        progress: [],
        children: [],
      },
    },
  } as unknown as WorkspaceViewSnapshot;
  const row = runsWorkspaceView.project(snapshot)[0];
  assert.ok(row);

  const presentation = row.present({
    width: 120,
    activeRunId: root.run.id,
    expanded: false,
  });
  assert.equal(presentation.active, true);
  assert.equal(
    presentation.spans.some((span) => span.tone === "accent"),
    true,
  );
  assert.equal(
    presentation.spans.some((span) => span.strong),
    true,
  );
  assert.equal(
    presentation.spans.map((span) => span.text).join("").includes(ANSI_ESCAPE_PREFIX),
    false,
  );
});

function runNode(
  id: string,
  state: RunSnapshot["state"],
  kind: RunSnapshot["kind"] = "agent",
): RunTreeNode {
  return {
    run: {
      id: runId(id),
      kind,
      state,
      definitionId: kind === "root" ? "session.root" : "agent.test",
    } as RunSnapshot,
    children: [],
  };
}
