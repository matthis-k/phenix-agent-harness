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

test("completed QA runs render all compact checks and findings as canonical Markdown tables", () => {
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
        files: ["modules/phenix-pi/application/agent-executor.ts"],
        notes: "Enforce the policy at the child tool boundary.",
      },
      {
        severity: "low",
        kind: "architecture",
        description: "second",
        files: ["src/one.ts", "src/two.ts"],
        notes: "y".repeat(8_000),
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
      readonly kind?: string;
      readonly description: string;
      readonly files: readonly string[];
      readonly notes?: string;
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
  assert.match(result.text, /\| # \| Severity \| Kind \| Description \| Files \| Notes \|/);
  assert.match(
    result.text,
    /\| 1 \| HIGH \| security \| free mutation guard is bypassed \| modules\/phenix-pi\/application\/agent-executor\.ts \|/,
  );
  assert.match(
    result.text,
    /\| 2 \| LOW \| architecture \| second \| src\/one\.ts<br>src\/two\.ts \|/,
  );
  assert.doesNotMatch(result.text, /### Finding counts/);
  assert.equal(details.runId, "run-1");
  assert.equal(details.status, "success");
  assert.equal(
    details.summary,
    "Deterministic gates passed while review findings require attention.",
  );
  assert.equal(details.checkCount, 8);
  assert.equal(details.checks.length, 8);
  assert.deepEqual(details.checks[0], { command: "check-1", ok: true, summary: "passed" });
  assert.equal(details.findingCount, 2);
  assert.equal(details.findings[0]?.severity, "high");
  assert.equal(details.findings[0]?.kind, "security");
  assert.equal(details.findings[0]?.description, "free mutation guard is bypassed");
  assert.deepEqual(details.findings[1]?.files, ["src/one.ts", "src/two.ts"]);
  assert.equal(details.findings[1]?.notes?.length, 500);
  assert.equal(details.findings[1]?.notes?.endsWith("…"), true);
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
          kind: "architecture",
          description: "dependency direction is unclear",
          files: ["modules/phenix-pi/definitions/schemas.ts"],
          notes: "Restore one-way ownership.",
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
  assert.match(
    result.text,
    /\| 1 \| MEDIUM \| architecture \| dependency direction is unclear \| modules\/phenix-pi\/definitions\/schemas\.ts \|/,
  );
  assert.doesNotMatch(result.text, /"hasOutcome":true/);
});

test("empty QA findings still render the canonical findings table", () => {
  const result = projectedToolResult(
    projectCompletedRun(
      "run-clear" as RunId,
      success({
        summary: "Clear",
        checks: [],
        findings: [],
        reports: [],
      }),
    ),
  );

  assert.match(result.text, /\| # \| Severity \| Kind \| Description \| Files \| Notes \|/);
  assert.match(
    result.text,
    /\| — \| — \| — \| No review findings were reported\. \| — \| — \|/,
  );
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
        { description: "first issue", files: [] },
        { description: "second issue", files: [] },
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
        files: ["tests/example.test.ts"],
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
