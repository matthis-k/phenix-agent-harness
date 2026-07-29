import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import { summarizeRunFailures } from "../application/run-failure-health.ts";
import type { RunKind, RunRecord, RunState } from "../domain/run/model.ts";
import { definitionId, failed, type RunId, runId, success } from "../domain/shared.ts";

const root = record("root", "root", "running");

function record(
  id: string,
  kind: RunKind,
  state: RunState,
  input: {
    readonly parentId?: RunId;
    readonly retryOf?: RunId;
  } = {},
): RunRecord {
  const outcome =
    state === "completed"
      ? success({})
      : state === "failed" || state === "orphaned"
        ? failed({ code: "provider_failed", message: `${id} failed`, retryable: true })
        : state === "cancelled"
          ? { status: "cancelled" as const, reason: `${id} cancelled` }
          : undefined;
  return {
    id: runId(id),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    kind,
    definitionId: definitionId(kind === "root" ? "root.session" : `${kind}.${id}`),
    input: {},
    outputSchemaId: "outcome.base",
    requestedAt: "2026-07-29T00:00:00.000Z",
    ownership: "attached",
    state,
    revision: 1,
    compiled: {
      definitionId: definitionId(kind === "root" ? "root.session" : `${kind}.${id}`),
      input: {},
      outputSchemaId: "outcome.base",
      tools: [],
      limits: { timeoutMs: 0 },
      capabilities: {
        invokableDefinitions: [],
        maxDepth: 8,
        mayDetach: false,
        maySend: false,
        mayCancelChildren: true,
      },
      invocation: {
        wait: "await",
        ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      },
    },
    ...(outcome ? { outcome } : {}),
  };
}

function node(run: RunRecord, children: readonly RunTreeNode[] = []): RunTreeNode {
  return { run: { ...run, activeChildren: [] }, children };
}

test("a failed child under an active workflow is recovering", () => {
  const workflow = record("qa", "workflow", "running", { parentId: root.id });
  const child = record("critic", "agent", "failed", { parentId: workflow.id });

  assert.deepEqual(summarizeRunFailures(node(root, [node(workflow, [node(child)])])), {
    recovering: 1,
    recovered: 0,
    terminal: 0,
  });
});

test("a failed child absorbed by a successful workflow is recovered", () => {
  const workflow = record("qa", "workflow", "completed", { parentId: root.id });
  const child = record("critic", "agent", "failed", { parentId: workflow.id });

  assert.deepEqual(summarizeRunFailures(node(root, [node(workflow, [node(child)])])), {
    recovering: 0,
    recovered: 1,
    terminal: 0,
  });
});

test("a failed workflow is one terminal incident regardless of nested failures", () => {
  const workflow = record("qa", "workflow", "failed", { parentId: root.id });
  const child = record("critic", "agent", "failed", { parentId: workflow.id });

  assert.deepEqual(summarizeRunFailures(node(root, [node(workflow, [node(child)])])), {
    recovering: 0,
    recovered: 0,
    terminal: 1,
  });
});

test("an active retry changes a terminal attempt into recovering", () => {
  const original = record("critic-1", "agent", "failed", { parentId: root.id });
  const retry = record("critic-2", "agent", "running", {
    parentId: root.id,
    retryOf: original.id,
  });

  assert.deepEqual(summarizeRunFailures(node(root, [node(original), node(retry)])), {
    recovering: 1,
    recovered: 0,
    terminal: 0,
  });
});

test("a successful retry marks the incident recovered", () => {
  const original = record("critic-1", "agent", "failed", { parentId: root.id });
  const retry = record("critic-2", "agent", "completed", {
    parentId: root.id,
    retryOf: original.id,
  });

  assert.deepEqual(summarizeRunFailures(node(root, [node(original), node(retry)])), {
    recovering: 0,
    recovered: 1,
    terminal: 0,
  });
});

test("an exhausted retry chain remains one terminal incident", () => {
  const original = record("critic-1", "agent", "failed", { parentId: root.id });
  const retry = record("critic-2", "agent", "failed", {
    parentId: root.id,
    retryOf: original.id,
  });

  assert.deepEqual(summarizeRunFailures(node(root, [node(original), node(retry)])), {
    recovering: 0,
    recovered: 0,
    terminal: 1,
  });
});
