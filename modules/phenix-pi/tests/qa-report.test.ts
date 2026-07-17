/**
 * Tests for QA report generation, gate calculation, and scoring.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AnalysisCoverage,
  QaEvidence,
  QaFinding,
  ReviewScope,
} from "../skills/phenix-qa/contracts/contracts.ts";
import { DEFAULT_QA_CONFIG } from "../skills/phenix-qa/runtime/config.ts";
import { renderTextReport } from "../skills/phenix-qa/runtime/render-text.ts";
import {
  buildReportSkeleton,
  calculateCompositeScore,
  calculateGates,
  calculateRiskScores,
  mergeModelContribution,
} from "../skills/phenix-qa/runtime/report.ts";

const scope: ReviewScope = {
  kind: "diff",
  description: "Test diff",
  baseRevision: "main",
};

function emptyCoverage(): AnalysisCoverage {
  return {
    requestedAnalyzers: [],
    completedAnalyzers: [],
    unavailableAnalyzers: [],
    failedAnalyzers: [],
    coveredFiles: 0,
    totalScopedFiles: 0,
    coveredLanguages: [],
    uncoveredLanguages: [],
  };
}

describe("Report skeleton", () => {
  it("builds a valid skeleton", () => {
    const report = buildReportSkeleton({
      scope,
      evidence: [],
      findings: [],
      coverage: emptyCoverage(),
    });

    assert.equal(report.scope.kind, "diff");
    assert.ok(report.generatedAt);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(report.generatedAt));
    assert.equal(report.executiveSummary.overallResult, "REVIEW");
    assert.equal(report.executiveSummary.architectureAssessment, "not-reviewed");
    assert.equal(report.findings.length, 0);
    assert.equal(report.evidence.length, 0);
    assert.equal(report.riskAssessment.compositeScore, 0);
  });

  it("skeleton has all required risk dimensions", () => {
    const report = buildReportSkeleton({
      scope,
      evidence: [],
      findings: [],
      coverage: emptyCoverage(),
    });

    const ra = report.riskAssessment;
    assert.ok(ra.complexityRisk);
    assert.ok(ra.readabilityRisk);
    assert.ok(ra.patternConsistencyRisk);
    assert.ok(ra.architectureRisk);
    assert.ok(ra.integrationRisk);
    assert.ok(ra.operationalRisk);
    assert.ok(ra.securityRisk);
    assert.ok(ra.changeRisk);
    assert.equal(typeof ra.compositeScore, "number");
  });
});

describe("Gate calculation", () => {
  it("empty findings with no analyzer coverage produce NOT_RUN correctness", () => {
    const gates = calculateGates([], emptyCoverage(), DEFAULT_QA_CONFIG);

    assert.equal(gates.correctness.result, "NOT_RUN");
    assert.equal(gates.changeSafety.result, "NOT_RUN");
    assert.equal(gates.designConsistency.result, "PASS");
    assert.equal(gates.architecture.result, "PASS");
    assert.equal(gates.productionReadiness.result, "PASS");
  });

  it("blocking finding produces FAIL", () => {
    const finding: QaFinding = {
      id: "f-1",
      level: "level-0-correctness",
      severity: "high",
      confidence: "high",
      title: "Build fails",
      explanation: "The build fails.",
      evidenceIds: [],
      locations: [],
      impact: "Cannot release.",
      recommendation: "Fix build.",
      remediationScope: "local",
      introducedByCurrentChange: true,
      blocking: true,
    };

    const gates = calculateGates(
      [finding],
      {
        ...emptyCoverage(),
        completedAnalyzers: ["project-native"],
      },
      DEFAULT_QA_CONFIG,
    );

    assert.equal(gates.correctness.result, "FAIL");
    assert.deepEqual(gates.correctness.failingFindings, ["f-1"]);
  });

  it("high severity non-blocking produces REVIEW", () => {
    const finding: QaFinding = {
      id: "f-1",
      level: "level-4-architecture",
      severity: "high",
      confidence: "medium",
      title: "Architecture concern",
      explanation: "Concern.",
      evidenceIds: [],
      locations: [],
      impact: "Architecture.",
      recommendation: "Review.",
      remediationScope: "module-refactor",
      introducedByCurrentChange: false,
      blocking: false,
    };

    const gates = calculateGates([finding], emptyCoverage(), DEFAULT_QA_CONFIG);

    assert.equal(gates.architecture.result, "REVIEW");
    assert.deepEqual(gates.architecture.failingFindings, ["f-1"]);
  });
});

describe("Risk scoring", () => {
  it("no findings produce zero risk scores", () => {
    const scores = calculateRiskScores([], []);
    assert.equal(scores.compositeScore, 0);
    assert.equal(scores.complexityRisk.value, 0);
    assert.equal(scores.readabilityRisk.value, 0);
    assert.equal(scores.architectureRisk.value, 0);
  });

  it("critical finding produces high risk", () => {
    const finding: QaFinding = {
      id: "f-1",
      level: "level-7-security",
      severity: "critical",
      confidence: "high",
      title: "Security vulnerability",
      explanation: "Vulnerability found.",
      evidenceIds: [],
      locations: [],
      impact: "Security.",
      recommendation: "Fix.",
      remediationScope: "local",
      introducedByCurrentChange: true,
      blocking: true,
    };

    const scores = calculateRiskScores([], [finding]);
    // Security risk should be elevated
    assert.ok(
      scores.securityRisk.value > 60,
      `Expected security risk > 60, got ${scores.securityRisk.value}`,
    );
  });

  it("composite score is between 0 and 100", () => {
    const scores = calculateRiskScores([], []);
    assert.ok(scores.compositeScore >= 0);
    assert.ok(scores.compositeScore <= 100);
  });
});

describe("Composite score calculation", () => {
  it("weights scores correctly", () => {
    const baseScore = {
      name: "test",
      value: 50,
      confidence: "medium" as const,
      rationale: "test",
      evidenceIds: [],
      unavailableInputs: [],
    };

    const scores = {
      complexityRisk: baseScore,
      readabilityRisk: baseScore,
      patternConsistencyRisk: baseScore,
      architectureRisk: baseScore,
      integrationRisk: baseScore,
      operationalRisk: baseScore,
      securityRisk: baseScore,
      changeRisk: baseScore,
    };

    const composite = calculateCompositeScore(scores);
    // All scores 50, weighted average should be 50
    assert.equal(composite, 50);
  });

  it("clamps to 0-100", () => {
    const highScore = {
      name: "test",
      value: 200,
      confidence: "low" as const,
      rationale: "test",
      evidenceIds: [],
      unavailableInputs: [],
    };

    const scores = {
      complexityRisk: highScore,
      readabilityRisk: highScore,
      patternConsistencyRisk: highScore,
      architectureRisk: highScore,
      integrationRisk: highScore,
      operationalRisk: highScore,
      securityRisk: highScore,
      changeRisk: highScore,
    };

    const composite = calculateCompositeScore(scores);
    assert.ok(composite <= 100);
    assert.ok(composite >= 0);
  });
});

describe("Text rendering", () => {
  it("renders a report to text", () => {
    const report = buildReportSkeleton({
      scope,
      evidence: [],
      findings: [],
      coverage: emptyCoverage(),
    });

    const text = renderTextReport(report);
    assert.ok(text.includes("Phenix QA Report"));
    assert.ok(text.includes("Executive Summary"));
    assert.ok(text.includes("Quality Gates"));
    assert.ok(text.includes("Risk Assessment"));
    assert.ok(text.includes("End of QA Report"));
  });

  it("renders findings correctly", () => {
    const finding: QaFinding = {
      id: "f-1",
      level: "level-0-correctness",
      severity: "critical",
      confidence: "high",
      title: "Test Finding",
      explanation: "Test explanation.",
      evidenceIds: [],
      locations: [{ path: "src/test.ts", startLine: 10 }],
      impact: "Test impact.",
      recommendation: "Test recommendation.",
      remediationScope: "local",
      introducedByCurrentChange: true,
      blocking: true,
    };

    const evidence: QaEvidence = {
      id: "ev-1",
      level: "level-0-correctness",
      source: "test",
      category: "test",
      message: "Test evidence",
      locations: [],
    };

    const report = buildReportSkeleton({
      scope,
      evidence: [evidence],
      findings: [finding],
      coverage: {
        ...emptyCoverage(),
        completedAnalyzers: ["project-native"],
      },
    });

    const text = renderTextReport(report);
    assert.ok(text.includes("Test Finding"));
    assert.ok(text.includes("BLOCKING"));
    assert.ok(text.includes("src/test.ts:10"));
  });
});

describe("Model contribution merging", () => {
  it("merges findings without duplicates", () => {
    const skeleton = buildReportSkeleton({
      scope,
      evidence: [],
      findings: [],
      coverage: emptyCoverage(),
    });

    const contribution = {
      findings: [
        {
          id: "f-1",
          level: "level-2-readability" as const,
          severity: "medium" as const,
          confidence: "high" as const,
          title: "Readability issue",
          explanation: "Readability.",
          evidenceIds: [],
          locations: [],
          impact: "Readability.",
          recommendation: "Improve.",
          remediationScope: "local" as const,
          introducedByCurrentChange: false as const,
          blocking: false,
        },
      ],
      positiveObservations: ["Good code."],
      remediationPlan: [],
    };

    const merged = mergeModelContribution(skeleton, contribution);
    assert.equal(merged.findings.length, 1);
    assert.equal(merged.positiveObservations.length, 1);
    assert.ok(merged.positiveObservations[0]?.includes("Good code."));
  });

  it("does not duplicate findings with same ID", () => {
    const finding: QaFinding = {
      id: "existing",
      level: "level-0-correctness",
      severity: "high",
      confidence: "high",
      title: "Existing",
      explanation: "Existing.",
      evidenceIds: [],
      locations: [],
      impact: ".",
      recommendation: ".",
      remediationScope: "local",
      introducedByCurrentChange: true,
      blocking: false,
    };

    const skeleton = buildReportSkeleton({
      scope,
      evidence: [],
      findings: [finding],
      coverage: emptyCoverage(),
    });

    const contribution = {
      findings: [
        {
          ...finding,
          title: "Updated title",
        },
      ],
      positiveObservations: [],
      remediationPlan: [],
    };

    const merged = mergeModelContribution(skeleton, contribution);
    // Should not duplicate; existing finding is preserved
    assert.equal(merged.findings.length, 1);
  });
});
