import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import { definitionId, runId } from "../domain/shared.ts";
import { renderRuns } from "../extension/run-monitor.ts";

const ROOT = runId("root-monitor");

test("run widget renders the complete run tree without a height cap", () => {
  const children = Array.from({ length: 50 }, (_, index): RunTreeNode => ({
    run: snapshot(runId(`run-${index}`), ROOT, "agent.scout"),
    children: [],
  }));
  const lines = renderRuns(
    {
      root: {
        run: snapshot(ROOT, undefined, "root.session"),
        children,
      },
    },
    [],
    123,
  );

  assert.equal(lines.filter((line) => line.includes("scout [running]")).length, 50);
  assert.equal(lines.some((line) => line.includes("run tree truncated")), false);
});

function snapshot(
  id: ReturnType<typeof runId>,
  parentId: ReturnType<typeof runId> | undefined,
  definition: string,
): RunSnapshot {
  const resolvedDefinition = definitionId(definition);
  return {
    id,
    ...(parentId ? { parentId } : {}),
    kind: parentId ? "agent" : "root",
    definitionId: resolvedDefinition,
    input: {},
    outputSchemaId: "test.output",
    requestedAt: "2026-07-24T00:00:00.000Z",
    ownership: "attached",
    state: "running",
    revision: 1,
    compiled: {
      definitionId: resolvedDefinition,
      input: {},
      outputSchemaId: "test.output",
      tools: [],
      limits: { timeoutMs: 0 },
      capabilities: {
        invokableDefinitions: [],
        maxDepth: 8,
        mayDetach: false,
        maySend: false,
        mayCancelChildren: false,
      },
      invocation: { wait: "background" },
    },
    activeChildren: [],
  };
}
