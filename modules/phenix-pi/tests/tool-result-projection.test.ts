import assert from "node:assert/strict";
import test from "node:test";

import {
  projectCompletedRun,
  projectDispatchResult,
  projectedToolResult,
  projectOutcome,
  projectRunSnapshot,
} from "../application/tool-result-projection.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import { type RunId, success } from "../domain/shared.ts";

test("completed QA runs remain structured JSON in tool transport", () => {
  const outcome = success({
    summary: "Deterministic gates passed while review findings require attention.",
    checks: Array.from({ length: 8 }, (_, index) => ({
      command: `check-${index + 1}`,
      ok: true,
      summary: "passed",
    })),
    findings: [
      {
        severity: "high",
        kind: "security",
        description: "free mutation guard is bypassed",
        locations: [{ path: "src/example.ts", line: 84 }],
        notes: "Enforce the policy at the child tool boundary.",
      },
    ],
    reports: [{ raw: "z".repeat(16_000) }],
  });
  const result = projectedToolResult(projectCompletedRun("run-1" as RunId, outcome), outcome);
  const parsed = JSON.parse(result.text) as Record<string, unknown>;
  const details = result.details as {
    readonly runId: string;
    readonly checkCount: number;
    readonly checks: readonly unknown[];
    readonly findingCount: number;
    readonly findings: readonly unknown[];
    readonly transport: {
      readonly sourceBytes: number;
      readonly inlineBytes: number;
      readonly omittedBytes: number;
    };
  };

  assert.equal(parsed.runId, "run-1");
  assert.equal(parsed.status, "success");
  assert.equal(details.checkCount, 8);
  assert.equal(details.checks.length, 8);
  assert.equal(details.findingCount, 1);
  assert.equal(details.findings.length, 1);
  assert.equal("reports" in details, false);
  assert.ok(details.transport.sourceBytes > details.transport.inlineBytes);
  assert.ok(details.transport.omittedBytes > 10_000);
  assert.doesNotMatch(result.text, /^# QA report/m);
});

test("completed QA dispatches preserve their envelope as JSON", () => {
  const projected = projectDispatchResult({
    definition: "workflow.qa",
    selectedBy: "dispatcher",
    runId: "run-qa" as RunId,
    classifierRunId: "run-classifier" as RunId,
    status: "completed",
    outcome: success({
      summary: "Checks passed.",
      checks: [{ command: "devenv test", ok: true, summary: "passed" }],
      findings: [],
      reports: [],
    }),
  });

  assert.deepEqual(JSON.parse(projectedToolResult(projected).text), projected);
});

test("an unavailable canonical gate remains typed data", () => {
  const projected = projectOutcome(
    success({
      summary: "The canonical gate was unavailable.",
      checks: [{ command: "devenv test", ok: false, summary: "spawn devenv ENOENT" }],
      findings: [],
    }),
  ) as { readonly checks: readonly { readonly status: string }[] };

  assert.equal(projected.checks[0]?.status, "unavailable");
});

test("string findings are normalized into finding objects", () => {
  assert.deepEqual(
    projectOutcome(
      success({
        summary: "Verification found two issues",
        findings: ["first issue", "second issue"],
      }),
    ),
    {
      status: "success",
      summary: "Verification found two issues",
      findingCount: 2,
      findings: [
        { description: "first issue", locations: [] },
        { description: "second issue", locations: [] },
      ],
      hasOutcome: true,
    },
  );
});

test("structured collections are count-preserving and bounded", () => {
  const projected = projectOutcome(
    success({
      summary: "many results",
      checks: Array.from({ length: 102 }, (_, index) => ({
        command: `check ${index + 1}`,
        ok: true,
        summary: "passed",
      })),
      findings: Array.from({ length: 52 }, (_, index) => ({
        severity: "low",
        kind: "tests",
        description: `finding ${index + 1}`,
        locations: [{ path: "tests/example.test.ts", line: index + 1 }],
        notes: "note",
      })),
    }),
  ) as {
    readonly checkCount: number;
    readonly checks: readonly unknown[];
    readonly omittedCheckCount: number;
    readonly findingCount: number;
    readonly findings: readonly unknown[];
    readonly omittedFindingCount: number;
  };

  assert.equal(projected.checkCount, 102);
  assert.equal(projected.checks.length, 100);
  assert.equal(projected.omittedCheckCount, 2);
  assert.equal(projected.findingCount, 52);
  assert.equal(projected.findings.length, 50);
  assert.equal(projected.omittedFindingCount, 2);
});

test("invalid location line ranges are normalized conservatively", () => {
  const projected = projectOutcome(
    success({
      summary: "one finding",
      findings: [
        {
          severity: "low",
          kind: "tests",
          description: "invalid end line",
          locations: [
            { path: "tests/example.test.ts", line: 20, endLine: 10 },
            { path: "tests/missing-line.test.ts" },
          ],
          notes: "note",
        },
      ],
    }),
  ) as { readonly findings: readonly { readonly locations: readonly unknown[] }[] };

  assert.deepEqual(projected.findings[0]?.locations, [{ path: "tests/example.test.ts", line: 20 }]);
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
    outputSchemaId: "outcome.test-report",
    requestedAt: "2026-01-01T00:00:00.000Z",
    ownership: "attached",
    state: "completed",
    revision: 4,
    compiled: {
      definitionId: "agent.tester",
      input: { objective: "large", context: "x".repeat(20_000) },
      outputSchemaId: "outcome.test-report",
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
