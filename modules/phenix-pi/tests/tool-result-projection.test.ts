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

test("completed QA runs render all compact checks and findings as Markdown tables", () => {
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
        title: "free mutation guard is bypassed",
        evidence: "child command sessions do not load the root extension guard",
        recommendation: "enforce the policy at the child tool boundary",
      },
      {
        severity: "low",
        title: "second",
        evidence: "y".repeat(8_000),
        recommendation: "fix second",
      },
    ],
    reports: [{ raw: "z".repeat(16_000) }],
  });
  const projected = projectCompletedRun("run-1" as RunId, outcome);
  const result = projectedToolResult(projected, outcome);
  const details = result.details as {
    readonly runId: string;
    readonly status: string;
    readonly summary: string;
    readonly checkCount: number;
    readonly checks: readonly {
      readonly command: string;
      readonly ok: boolean;
      readonly summary: string;
    }[];
    readonly findingCount: number;
    readonly findings: readonly {
      readonly severity?: string;
      readonly title: string;
      readonly evidence?: string;
      readonly recommendation?: string;
    }[];
    readonly hasOutcome: boolean;
    readonly transport: {
      readonly sourceBytes: number;
      readonly inlineBytes: number;
      readonly omittedBytes: number;
    };
  };

  assert.match(result.text, /^## QA report/m);
  assert.match(result.text, /\*\*Run:\*\* `run-1`/);
  assert.match(result.text, /\*\*Gate status:\*\* Passed/);
  assert.match(result.text, /\*\*Review status:\*\* Attention required \(1 high\)/);
  assert.match(result.text, /\| Check \| Status \| Details \|/);
  assert.match(result.text, /\| check-1 \| PASS \| passed \|/);
  assert.match(result.text, /\| High \| 1 \|/);
  assert.match(result.text, /\| HIGH \| free mutation guard is bypassed \|/);
  assert.match(result.text, /\| LOW \| second \|/);
  assert.equal(details.runId, "run-1");
  assert.equal(details.status, "success");
  assert.equal(details.summary, "Deterministic gates passed while review findings require attention.");
  assert.equal(details.checkCount, 8);
  assert.equal(details.checks.length, 8);
  assert.deepEqual(details.checks[0], { command: "check-1", ok: true, summary: "passed" });
  assert.equal(details.findingCount, 2);
  assert.equal(details.findings[0]?.severity, "high");
  assert.equal(details.findings[0]?.title, "free mutation guard is bypassed");
  assert.equal(details.findings[1]?.evidence?.length, 500);
  assert.equal(details.findings[1]?.evidence?.endsWith("…"), true);
  assert.equal(details.hasOutcome, true);
  assert.equal("reports" in details, false);
  assert.ok(details.transport.sourceBytes > details.transport.inlineBytes);
  assert.ok(details.transport.omittedBytes > 20_000);
});

test("completed QA dispatches render the report instead of a prose-only JSON summary", () => {
  const projected = projectDispatchResult({
    definition: "workflow.qa",
    selectedBy: "dispatcher",
    runId: "run-qa" as RunId,
    classifierRunId: "run-classifier" as RunId,
    status: "completed",
    outcome: success({
      summary: "Checks passed with one non-blocking architecture finding.",
      checks: [{ command: "devenv test", ok: true, summary: "passed" }],
      findings: [
        {
          severity: "medium",
          title: "dependency direction is unclear",
          evidence: "definitions imports composition",
          recommendation: "restore one-way ownership",
        },
      ],
      reports: [],
    }),
  });

  const result = projectedToolResult(projected);
  assert.match(result.text, /^## QA report/m);
  assert.match(result.text, /\*\*Definition:\*\* `workflow\.qa`/);
  assert.match(result.text, /\*\*Run:\*\* `run-qa`/);
  assert.match(result.text, /\| devenv test \| PASS \| passed \|/);
  assert.match(result.text, /\| MEDIUM \| dependency direction is unclear \|/);
  assert.doesNotMatch(result.text, /"hasOutcome":true/);
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
      findings: [{ title: "first issue" }, { title: "second issue" }],
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
        title: `finding ${index + 1}`,
        evidence: "evidence",
        recommendation: "recommendation",
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
