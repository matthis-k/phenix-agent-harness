import assert from "node:assert/strict";
import test from "node:test";

import {
  projectCompletedRun,
  projectOutcome,
  projectRunSnapshot,
  projectedToolResult,
} from "../application/tool-result-projection.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import { success, type RunId } from "../domain/shared.ts";

test("completed runs inline only a compact summary by default", () => {
  const outcome = success({
    summary: "QA found two actionable issues",
    findings: [
      { title: "first", evidence: "x".repeat(8_000) },
      { title: "second", evidence: "y".repeat(8_000) },
    ],
    reports: [{ raw: "z".repeat(16_000) }],
  });
  const projected = projectCompletedRun("run-1" as RunId, outcome);
  const result = projectedToolResult(projected, outcome);
  const parsed = JSON.parse(result.text) as Record<string, unknown>;
  const details = result.details as {
    readonly transport: { readonly sourceBytes: number; readonly inlineBytes: number; readonly omittedBytes: number };
  };

  assert.deepEqual(parsed, {
    runId: "run-1",
    status: "success",
    summary: "QA found two actionable issues",
    hasOutcome: true,
  });
  assert.ok(details.transport.sourceBytes > details.transport.inlineBytes);
  assert.ok(details.transport.omittedBytes > 20_000);
});

test("explicit outcome view preserves the complete typed value", () => {
  const outcome = success({ summary: "done", findings: ["full evidence"] });
  assert.deepEqual(projectOutcome(outcome, "outcome"), outcome);
});

test("summary run inspection excludes repeated input and compiled payloads", () => {
  const snapshot = {
    id: "run-2",
    parentId: "root-1",
    kind: "agent",
    definitionId: "agent.tester",
    input: { objective: "large", context: "x".repeat(20_000) },
    outputSchemaId: "outcome.test-report.v1",
    requestedAt: "2026-01-01T00:00:00.000Z",
    ownership: "attached",
    state: "completed",
    revision: 4,
    compiled: {
      definitionId: "agent.tester",
      input: { objective: "large", context: "x".repeat(20_000) },
      outputSchemaId: "outcome.test-report.v1",
      tools: ["read"],
      limits: { timeoutMs: 1_000 },
      capabilities: {
        invokableDefinitions: [],
        maxDepth: 1,
        mayDetach: false,
        maySend: false,
        mayCancelChildren: false,
      },
      invocation: { wait: "await" },
    },
    activeChildren: [],
    outcome: success({ summary: "complete", evidence: ["y".repeat(10_000)] }),
  } as unknown as RunSnapshot;

  const projected = projectRunSnapshot(snapshot) as Record<string, unknown>;
  assert.equal(projected.runId, "run-2");
  assert.equal("input" in projected, false);
  assert.equal("compiled" in projected, false);
  assert.deepEqual(projected.outcome, {
    status: "success",
    summary: "complete",
    hasOutcome: true,
  });
});
