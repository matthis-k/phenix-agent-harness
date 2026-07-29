import assert from "node:assert/strict";
import test from "node:test";

import { HealthDiagnosticLog } from "../application/health-diagnostic-log.ts";
import type { QueryFacade, RunTreeNode } from "../application/interfaces.ts";
import type { DiagnosticSummary } from "../domain/diagnostics.ts";
import type { RunKind, RunRecord, RunState } from "../domain/run/model.ts";
import { definitionId, failed, type RunId, runId, success } from "../domain/shared.ts";
import type { DiagnosticLog } from "../ports/diagnostic-log.ts";

const rootRunId = runId("root-diagnostics");

function record(
  id: string,
  kind: RunKind,
  state: RunState,
  parentId?: RunId,
): RunRecord {
  const outcome =
    state === "completed"
      ? success({})
      : state === "failed"
        ? failed({ code: "provider_failed", message: `${id} failed`, retryable: true })
        : undefined;
  const idValue = runId(id);
  const definition = definitionId(kind === "root" ? "root.session" : `${kind}.${id}`);
  return {
    id: idValue,
    ...(parentId ? { parentId } : {}),
    kind,
    definitionId: definition,
    input: {},
    outputSchemaId: "outcome.base",
    requestedAt: "2026-07-29T00:00:00.000Z",
    ownership: "attached",
    state,
    revision: 1,
    compiled: {
      definitionId: definition,
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
      invocation: { wait: "await" },
    },
    ...(outcome ? { outcome } : {}),
  };
}

function node(run: RunRecord, children: readonly RunTreeNode[] = []): RunTreeNode {
  return { run: { ...run, activeChildren: [] }, children };
}

function diagnosticLog(summary: DiagnosticSummary): DiagnosticLog {
  return {
    summary: async () => summary,
    record: async () => {
      throw new Error("not used");
    },
    entries: async () => [],
    export: async () => "",
    resolve: async () => "",
    pathFor: () => undefined,
    artifactDirectoryFor: () => undefined,
    subscribe: () => () => undefined,
    drain: async () => undefined,
  };
}

function queries(tree: RunTreeNode): QueryFacade {
  return {
    runTree: async () => ({ root: tree }),
  } as unknown as QueryFacade;
}

const observed: DiagnosticSummary = {
  total: 12,
  artifacts: 1,
  counts: { trace: 2, info: 3, warning: 2, error: 5 },
};

test("health projection replaces historical errors with active failure incidents", async () => {
  const root = record("root-diagnostics", "root", "running");
  const workflow = record("qa", "workflow", "running", root.id);
  const child = record("critic", "agent", "failed", workflow.id);
  const log = new HealthDiagnosticLog(
    diagnosticLog(observed),
    queries(node(root, [node(workflow, [node(child)])])),
  );

  const summary = await log.summary(rootRunId);
  assert.deepEqual(summary.observedCounts, observed.counts);
  assert.deepEqual(summary.failures, { recovering: 1, recovered: 0, terminal: 0 });
  assert.deepEqual(summary.counts, { trace: 2, info: 3, warning: 1, error: 0 });
  assert.equal(summary.total, 12);
});

test("recovered history remains visible without degrading current health", async () => {
  const root = record("root-diagnostics", "root", "running");
  const workflow = record("qa", "workflow", "completed", root.id);
  const child = record("critic", "agent", "failed", workflow.id);
  const log = new HealthDiagnosticLog(
    diagnosticLog(observed),
    queries(node(root, [node(workflow, [node(child)])])),
  );

  const summary = await log.summary(rootRunId);
  assert.deepEqual(summary.failures, { recovering: 0, recovered: 1, terminal: 0 });
  assert.equal(summary.counts.warning, 0);
  assert.equal(summary.counts.error, 0);
  assert.equal(summary.observedCounts?.error, 5);
});

test("a failed workflow boundary is a terminal health error", async () => {
  const root = record("root-diagnostics", "root", "running");
  const workflow = record("qa", "workflow", "failed", root.id);
  const child = record("critic", "agent", "failed", workflow.id);
  const log = new HealthDiagnosticLog(
    diagnosticLog(observed),
    queries(node(root, [node(workflow, [node(child)])])),
  );

  const summary = await log.summary(rootRunId);
  assert.deepEqual(summary.failures, { recovering: 0, recovered: 0, terminal: 1 });
  assert.equal(summary.counts.warning, 0);
  assert.equal(summary.counts.error, 1);
});
