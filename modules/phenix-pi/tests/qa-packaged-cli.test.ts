import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runPackagedQaCli } from "../skills/phenix-qa/runtime/cli.ts";
import { buildReportSkeleton } from "../skills/phenix-qa/runtime/report.ts";

describe("packaged QA CLI", () => {
  it("merges a model-assisted contribution into JSON and text reports", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "phenix-qa-cli-"));
    const reportPath = path.join(cwd, "qa-report.json");
    const contributionPath = path.join(cwd, "model-review.json");
    try {
      const report = buildReportSkeleton({
        scope: { kind: "repository", description: "CLI merge test" },
        evidence: [],
        findings: [],
        coverage: {
          requestedAnalyzers: [],
          completedAnalyzers: [],
          unavailableAnalyzers: [],
          failedAnalyzers: [],
          coveredFiles: 0,
          totalScopedFiles: 0,
          coveredLanguages: [],
          uncoveredLanguages: [],
        },
      });
      fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`, "utf8");
      fs.writeFileSync(
        contributionPath,
        `${JSON.stringify({
          findings: [],
          positiveObservations: ["Model review completed."],
          remediationPlan: [],
        })}\n`,
        "utf8",
      );

      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runPackagedQaCli(["merge-review", reportPath, contributionPath], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      });

      assert.equal(exitCode, 0, stderr.join("\n"));
      const merged = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        positiveObservations: string[];
      };
      assert.deepEqual(merged.positiveObservations, ["Model review completed."]);
      assert.ok(fs.existsSync(path.join(cwd, "qa-report.txt")));
      assert.ok(stdout.some((line) => line === "QA REVIEW"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
