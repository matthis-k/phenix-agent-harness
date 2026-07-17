/**
 * Tests for Phenix QA runtime schemas and validation.
 *
 * Run with: node --experimental-strip-types --test
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// We can't typebox-resolve at the top level in test environment.
// These tests verify the schema shapes at runtime by constructing
// valid/invalid objects and running the validators (when typebox is available).

// Import what we can; skip validation tests when typebox is unavailable.
let validateQaEvidence: (value: unknown) => unknown;
let validateQaFinding: (value: unknown) => unknown;
let validateQaReport: (value: unknown) => unknown;
let assertQaReport: (value: unknown) => unknown;

let schemasAvailable = false;

try {
  const mod = await import("../skills/phenix-qa/contracts/contracts.ts");
  validateQaEvidence = mod.validateQaEvidence;
  validateQaFinding = mod.validateQaFinding;
  validateQaReport = mod.validateQaReport;
  assertQaReport = mod.assertQaReport;
  schemasAvailable = true;
} catch {
  // typebox not available in test environment; skip validation tests
}

const describeValidation = schemasAvailable ? describe : describe.skip;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeValidEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-evidence-001",
    level: "level-0-correctness",
    source: "test",
    category: "typecheck",
    message: "TypeScript typecheck passed.",
    locations: [{ path: "test.ts" }],
    ...overrides,
  };
}

function makeValidFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-finding-001",
    level: "level-0-correctness",
    severity: "high",
    confidence: "high",
    title: "Build failure",
    explanation: "The build failed due to type errors.",
    evidenceIds: ["test-evidence-001"],
    locations: [{ path: "test.ts", startLine: 1 }],
    impact: "Cannot deploy.",
    recommendation: "Fix type errors.",
    remediationScope: "local",
    introducedByCurrentChange: true,
    blocking: true,
    ...overrides,
  };
}

function makeValidReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    scope: {
      kind: "diff",
      description: "Test diff scope",
      baseRevision: "main",
    },
    generatedAt: new Date().toISOString(),
    executiveSummary: {
      overallResult: "REVIEW",
      blockingIssues: [],
      architectureAssessment: "not-reviewed",
      currentChangeIncreasesDebt: "unknown",
      analysisCoverage: {
        requestedAnalyzers: ["project-native"],
        completedAnalyzers: ["project-native"],
        unavailableAnalyzers: [],
        failedAnalyzers: [],
        coveredFiles: 5,
        totalScopedFiles: 10,
        coveredLanguages: ["TypeScript"],
        uncoveredLanguages: [],
      },
      unavailableChecks: [],
    },
    qualityGates: {
      correctness: {
        name: "Gate A — Correctness",
        result: "PASS",
        failingFindings: [],
        notes: "",
      },
      changeSafety: {
        name: "Gate B — Change Safety",
        result: "PASS",
        failingFindings: [],
        notes: "",
      },
      designConsistency: {
        name: "Gate C — Design Consistency",
        result: "PASS",
        failingFindings: [],
        notes: "",
      },
      architecture: {
        name: "Gate D — Architecture",
        result: "NOT_RUN",
        failingFindings: [],
        notes: "",
      },
      productionReadiness: {
        name: "Gate E — Production Readiness",
        result: "NOT_RUN",
        failingFindings: [],
        notes: "",
      },
    },
    findings: [],
    evidence: [],
    riskAssessment: {
      complexityRisk: {
        name: "Local Complexity Risk",
        value: 0,
        confidence: "low",
        rationale: "Not assessed.",
        evidenceIds: [],
        unavailableInputs: [],
      },
      readabilityRisk: {
        name: "Readability Risk",
        value: 0,
        confidence: "low",
        rationale: "Not assessed.",
        evidenceIds: [],
        unavailableInputs: [],
      },
      patternConsistencyRisk: {
        name: "Pattern Consistency Risk",
        value: 0,
        confidence: "low",
        rationale: "Not assessed.",
        evidenceIds: [],
        unavailableInputs: [],
      },
      architectureRisk: {
        name: "Architecture Risk",
        value: 0,
        confidence: "low",
        rationale: "Not assessed.",
        evidenceIds: [],
        unavailableInputs: [],
      },
      integrationRisk: {
        name: "System Integration Risk",
        value: 0,
        confidence: "low",
        rationale: "Not assessed.",
        evidenceIds: [],
        unavailableInputs: [],
      },
      operationalRisk: {
        name: "Operational Risk",
        value: 0,
        confidence: "low",
        rationale: "Not assessed.",
        evidenceIds: [],
        unavailableInputs: [],
      },
      securityRisk: {
        name: "Security Risk",
        value: 0,
        confidence: "low",
        rationale: "Not assessed.",
        evidenceIds: [],
        unavailableInputs: [],
      },
      changeRisk: {
        name: "Change Risk",
        value: 0,
        confidence: "low",
        rationale: "Not assessed.",
        evidenceIds: [],
        unavailableInputs: [],
      },
      compositeScore: 0,
    },
    positiveObservations: [],
    remediationPlan: [],
    rawArtifacts: [],
    ...overrides,
  };
}

// ── Schema Tests ─────────────────────────────────────────────────────────────

describeValidation("QaEvidence validation", () => {
  it("accepts valid evidence", () => {
    const result = validateQaEvidence(makeValidEvidence());
    assert.equal(result.ok, true);
  });

  it("rejects evidence with invalid QA level", () => {
    const result = validateQaEvidence(makeValidEvidence({ level: "invalid-level" }));
    assert.equal(result.ok, false);
  });

  it("rejects evidence with empty ID", () => {
    const result = validateQaEvidence(makeValidEvidence({ id: "" }));
    assert.equal(result.ok, false);
  });

  it("rejects evidence with empty message", () => {
    const result = validateQaEvidence(makeValidEvidence({ message: "" }));
    assert.equal(result.ok, false);
  });

  it("rejects evidence with invalid source", () => {
    const result = validateQaEvidence(makeValidEvidence({ source: "made-up-source" }));
    assert.equal(result.ok, false);
  });
});

describeValidation("QaFinding validation", () => {
  it("accepts valid finding", () => {
    const result = validateQaFinding(makeValidFinding());
    assert.equal(result.ok, true);
  });

  it("rejects finding with empty title", () => {
    const result = validateQaFinding(makeValidFinding({ title: "" }));
    assert.equal(result.ok, false);
  });

  it("rejects finding with empty explanation", () => {
    const result = validateQaFinding(makeValidFinding({ explanation: "" }));
    assert.equal(result.ok, false);
  });

  it("rejects finding with empty impact", () => {
    const result = validateQaFinding(makeValidFinding({ impact: "" }));
    assert.equal(result.ok, false);
  });

  it("rejects finding with empty recommendation", () => {
    const result = validateQaFinding(makeValidFinding({ recommendation: "" }));
    assert.equal(result.ok, false);
  });

  it("rejects finding with invalid severity", () => {
    const result = validateQaFinding(makeValidFinding({ severity: "extreme" }));
    assert.equal(result.ok, false);
  });

  it("rejects finding with invalid introducedByCurrentChange", () => {
    const result = validateQaFinding(makeValidFinding({ introducedByCurrentChange: "maybe" }));
    assert.equal(result.ok, false);
  });

  it("rejects finding with invalid remediation scope", () => {
    const result = validateQaFinding(makeValidFinding({ remediationScope: "total-rewrite" }));
    assert.equal(result.ok, false);
  });
});

describeValidation("QaReport validation", () => {
  it("accepts valid report", () => {
    const result = validateQaReport(makeValidReport());
    assert.equal(result.ok, true);
  });

  it("rejects report with invalid architecture assessment", () => {
    const result = validateQaReport(
      makeValidReport({
        executiveSummary: {
          ...makeValidReport().executiveSummary,
          architectureAssessment: "maybe-consistent",
        },
      }),
    );
    assert.equal(result.ok, false);
  });

  it("rejects report with risk value below 0", () => {
    const report = makeValidReport();
    report.riskAssessment.complexityRisk.value = -5;
    const result = validateQaReport(report);
    assert.equal(result.ok, false);
  });

  it("rejects report with risk value above 100", () => {
    const report = makeValidReport();
    report.riskAssessment.complexityRisk.value = 150;
    const result = validateQaReport(report);
    assert.equal(result.ok, false);
  });

  it("rejects report with composite score below 0", () => {
    const report = makeValidReport();
    report.riskAssessment.compositeScore = -10;
    const result = validateQaReport(report);
    assert.equal(result.ok, false);
  });

  it("rejects report with composite score above 100", () => {
    const report = makeValidReport();
    report.riskAssessment.compositeScore = 101;
    const result = validateQaReport(report);
    assert.equal(result.ok, false);
  });

  it("rejects report with invalid generatedAt", () => {
    // generatedAt must be a string with minLength 1; invalid ISO will be caught by semantic validation
    const report = makeValidReport({ generatedAt: "" });
    const result = validateQaReport(report);
    assert.equal(result.ok, false);
  });

  it("rejects report with invalid gate result", () => {
    const report = makeValidReport();
    report.qualityGates.correctness.result = "MAYBE";
    const result = validateQaReport(report);
    assert.equal(result.ok, false);
  });

  it("rejects report with invalid scope kind", () => {
    const report = makeValidReport();
    report.scope.kind = "global";
    const result = validateQaReport(report);
    assert.equal(result.ok, false);
  });
});

describeValidation("assertQaReport", () => {
  it("does not throw for valid report", () => {
    assert.doesNotThrow(() => assertQaReport(makeValidReport()));
  });

  it("throws for invalid report", () => {
    assert.throws(() => assertQaReport(makeValidReport({ generatedAt: "" })));
  });
});

// ── Semantic Validation Tests ────────────────────────────────────────────────

describe("Semantic validation", () => {
  let validateReportSemantics: (report: unknown) => {
    ok: boolean;
    issues: readonly { path: string; message: string }[];
  };

  before(async () => {
    const mod = await import("../skills/phenix-qa/runtime/semantic-validation.ts");
    validateReportSemantics = mod.validateReportSemantics;
  });

  it("passes a valid complete report", () => {
    const report = makeValidReport();
    const result = validateReportSemantics(report);
    assert.equal(result.ok, true);
  });

  it("detects evidence reference mismatch", () => {
    const report = makeValidReport();
    report.findings = [makeValidFinding({ evidenceIds: ["nonexistent-evidence"] })];
    const result = validateReportSemantics(report);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes("not found in report evidence")));
  });

  it("detects gate reference mismatch", () => {
    const report = makeValidReport();
    report.qualityGates.correctness.failingFindings = ["nonexistent-finding"];
    const result = validateReportSemantics(report);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes("not found in report findings")));
  });

  it("detects duplicate finding IDs", () => {
    const report = makeValidReport();
    const finding = makeValidFinding({ id: "dup-id" });
    report.findings = [finding, finding];
    const result = validateReportSemantics(report);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes("Duplicate finding ID")));
  });

  it("detects duplicate evidence IDs", () => {
    const report = makeValidReport();
    const evidence = makeValidEvidence({ id: "dup-evid" });
    report.evidence = [evidence, evidence];
    const result = validateReportSemantics(report);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes("Duplicate evidence ID")));
  });

  it("detects blocking with non-high/non-critical severity", () => {
    const report = makeValidReport();
    report.findings = [makeValidFinding({ severity: "low", blocking: true })];
    const result = validateReportSemantics(report);
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (i) =>
          i.message.includes("blocking") &&
          i.message.includes("high") &&
          i.message.includes("critical"),
      ),
    );
  });

  it("allows blocking with high severity", () => {
    const report = makeValidReport();
    report.findings = [makeValidFinding({ severity: "high", blocking: true })];
    const result = validateReportSemantics(report);
    // This should not have a blocking-related issue
    const blockingIssues = result.issues.filter((i) => i.message.includes("blocking"));
    assert.equal(blockingIssues.length, 0);
  });

  it("detects invalid ISO timestamp", () => {
    const report = makeValidReport({ generatedAt: "not-a-timestamp" });
    const result = validateReportSemantics(report);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes("ISO")));
  });

  it("detects remediation reference to nonexistent finding", () => {
    const report = makeValidReport();
    report.remediationPlan = [
      {
        priority: 1,
        category: "test",
        findingIds: ["nonexistent-finding"],
        description: "Fix it.",
      },
    ];
    const result = validateReportSemantics(report);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes("not found in report findings")));
  });

  it("detects model-level finding with no evidence", () => {
    const report = makeValidReport();
    report.findings = [
      makeValidFinding({
        level: "level-2-readability",
        severity: "medium",
        evidenceIds: [],
      }),
    ];
    const result = validateReportSemantics(report);
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (i) => i.message.includes("Model-assisted") && i.message.includes("at least one evidence"),
      ),
    );
  });

  it("detects risk evidence reference mismatch", () => {
    const report = makeValidReport();
    report.riskAssessment.complexityRisk.evidenceIds = ["nonexistent-evid"];
    report.evidence = [makeValidEvidence({ id: "ev-1" })];
    const result = validateReportSemantics(report);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes("Risk evidence reference")));
  });
});

// ── Model Review Contribution Tests ──────────────────────────────────────────

describeValidation("Model review contribution", () => {
  let validateModelReviewContribution: (value: unknown) => unknown;

  before(async () => {
    const mod = await import("../skills/phenix-qa/contracts/contracts.ts");
    validateModelReviewContribution = mod.validateModelReviewContribution;
  });

  it("accepts valid model contribution", () => {
    const contribution = {
      findings: [makeValidFinding()],
      positiveObservations: ["Well-structured code."],
      remediationPlan: [],
    };
    const result = validateModelReviewContribution(contribution);
    assert.equal(result.ok, true);
  });

  it("rejects contribution with invalid finding", () => {
    const contribution = {
      findings: [makeValidFinding({ title: "" })],
      positiveObservations: [],
      remediationPlan: [],
    };
    const result = validateModelReviewContribution(contribution);
    assert.equal(result.ok, false);
  });

  it("rejects contribution with invalid risk score value", () => {
    const contribution = {
      findings: [],
      positiveObservations: [],
      remediationPlan: [],
      readabilityRisk: {
        name: "Readability Risk",
        value: 999,
        confidence: "low",
        rationale: "bad",
        evidenceIds: [],
        unavailableInputs: [],
      },
    };
    const result = validateModelReviewContribution(contribution);
    assert.equal(result.ok, false);
  });
});
