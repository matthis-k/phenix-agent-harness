import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { QaFinding } from "../skills/phenix-qa/contracts/contracts.ts";
import { buildReportSkeleton, mergeModelContribution } from "../skills/phenix-qa/runtime/report.ts";

const coverage = {
  requestedAnalyzers: ["project-native", "metrics"],
  completedAnalyzers: ["project-native", "metrics"],
  unavailableAnalyzers: [],
  failedAnalyzers: [],
  coveredFiles: 1,
  totalScopedFiles: 1,
  coveredLanguages: ["TypeScript"],
  uncoveredLanguages: [],
};

function finding(): QaFinding {
  return {
    id: "security-blocker",
    level: "level-7-security",
    severity: "high",
    confidence: "high",
    title: "Unsafe execution boundary",
    explanation: "Repository input reaches command execution.",
    evidenceIds: ["evidence-1"],
    locations: [{ path: "src/index.ts", startLine: 1 }],
    impact: "Untrusted code can execute.",
    recommendation: "Require explicit trust.",
    remediationScope: "system-change",
    introducedByCurrentChange: true,
    blocking: true,
  };
}

describe("QA merged executive summary", () => {
  it("recomputes blockers, highest risk, and change debt", () => {
    const skeleton = buildReportSkeleton({
      scope: { kind: "repository", description: "summary test" },
      evidence: [
        {
          id: "evidence-1",
          level: "level-7-security",
          source: "model-review",
          category: "security",
          message: "Unsafe command execution boundary.",
          locations: [],
        },
      ],
      findings: [],
      coverage,
    });

    const merged = mergeModelContribution(skeleton, {
      findings: [finding()],
      positiveObservations: [],
      remediationPlan: [],
    });

    assert.equal(merged.executiveSummary.overallResult, "FAIL");
    assert.deepEqual(merged.executiveSummary.blockingIssues, ["security-blocker"]);
    assert.equal(merged.executiveSummary.highestRiskLevel, "level-7-security");
    assert.equal(merged.executiveSummary.currentChangeIncreasesDebt, true);
  });
});
