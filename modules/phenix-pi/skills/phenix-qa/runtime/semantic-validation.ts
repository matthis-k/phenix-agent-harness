/**
 * Phenix QA — Semantic validation.
 *
 * Validates cross-reference invariants that cannot be expressed in
 * JSON Schema alone.
 */

import type { QaReport } from "../contracts/contracts.ts";

export interface SemanticValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface SemanticValidationResult {
  readonly ok: boolean;
  readonly issues: readonly SemanticValidationIssue[];
}

/**
 * Perform all semantic validations on a QA report.
 */
export function validateReportSemantics(report: QaReport): SemanticValidationResult {
  const issues: SemanticValidationIssue[] = [];

  // Validate evidence references
  validateEvidenceReferences(report, issues);

  // Validate gate references
  validateGateReferences(report, issues);

  // Validate risk evidence
  validateRiskEvidence(report, issues);

  // Validate timestamps
  validateTimestamp(report, issues);

  // Validate finding IDs are unique
  validateUniqueIds(report, issues);

  // Validate evidence IDs are unique
  validateUniqueEvidenceIds(report, issues);

  // Validate model-assisted findings have at least one evidence ID
  validateModelFindingsHaveEvidence(report, issues);

  // Validate blocking only on high/critical
  validateBlockingSeverity(report, issues);

  // Validate composite score bounds
  validateCompositeScore(report, issues);

  // Validate remediation finding IDs exist
  validateRemediationReferences(report, issues);

  return {
    ok: issues.length === 0,
    issues,
  };
}

function validateEvidenceReferences(report: QaReport, issues: SemanticValidationIssue[]): void {
  const evidenceIds = new Set(report.evidence.map((e) => e.id));

  for (const finding of report.findings) {
    for (const evidenceId of finding.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        issues.push({
          path: `findings.${finding.id}.evidenceIds`,
          message: `Evidence reference "${evidenceId}" not found in report evidence.`,
        });
      }
    }
  }
}

function validateGateReferences(report: QaReport, issues: SemanticValidationIssue[]): void {
  const findingIds = new Set(report.findings.map((f) => f.id));

  const gates = [
    report.qualityGates.correctness,
    report.qualityGates.changeSafety,
    report.qualityGates.designConsistency,
    report.qualityGates.architecture,
    report.qualityGates.productionReadiness,
  ];

  for (const gate of gates) {
    for (const findingId of gate.failingFindings) {
      if (!findingIds.has(findingId)) {
        issues.push({
          path: `qualityGates.${gate.name}.failingFindings`,
          message: `Failing finding "${findingId}" not found in report findings.`,
        });
      }
    }
  }
}

function validateRiskEvidence(report: QaReport, issues: SemanticValidationIssue[]): void {
  const evidenceIds = new Set(report.evidence.map((e) => e.id));

  const riskFields = [
    report.riskAssessment.complexityRisk,
    report.riskAssessment.readabilityRisk,
    report.riskAssessment.patternConsistencyRisk,
    report.riskAssessment.architectureRisk,
    report.riskAssessment.integrationRisk,
    report.riskAssessment.operationalRisk,
    report.riskAssessment.securityRisk,
    report.riskAssessment.changeRisk,
  ];

  for (const risk of riskFields) {
    for (const evidenceId of risk.evidenceIds) {
      if (evidenceId.length > 0 && !evidenceIds.has(evidenceId)) {
        issues.push({
          path: `riskAssessment.${risk.name}.evidenceIds`,
          message: `Risk evidence reference "${evidenceId}" not found in report evidence.`,
        });
      }
    }
  }
}

function validateTimestamp(report: QaReport, issues: SemanticValidationIssue[]): void {
  const timestamp = report.generatedAt;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp)) {
    issues.push({
      path: "generatedAt",
      message: `Invalid ISO timestamp: "${timestamp}". Must be ISO 8601.`,
    });
  }
}

function validateUniqueIds(report: QaReport, issues: SemanticValidationIssue[]): void {
  const seen = new Set<string>();
  for (const finding of report.findings) {
    if (seen.has(finding.id)) {
      issues.push({
        path: `findings.${finding.id}`,
        message: `Duplicate finding ID: "${finding.id}".`,
      });
    }
    seen.add(finding.id);
  }
}

function validateUniqueEvidenceIds(report: QaReport, issues: SemanticValidationIssue[]): void {
  const seen = new Set<string>();
  for (const evidence of report.evidence) {
    if (seen.has(evidence.id)) {
      issues.push({
        path: `evidence.${evidence.id}`,
        message: `Duplicate evidence ID: "${evidence.id}".`,
      });
    }
    seen.add(evidence.id);
  }
}

function validateModelFindingsHaveEvidence(
  report: QaReport,
  issues: SemanticValidationIssue[],
): void {
  for (const finding of report.findings) {
    if (
      finding.level === "level-2-readability" ||
      finding.level === "level-3-patterns" ||
      finding.level === "level-4-architecture" ||
      finding.level === "level-5-system" ||
      finding.level === "level-6-operability" ||
      finding.level === "level-7-security"
    ) {
      if (finding.evidenceIds.length === 0) {
        issues.push({
          path: `findings.${finding.id}.evidenceIds`,
          message: `Model-assisted finding "${finding.id}" must have at least one evidence reference.`,
        });
      }
    }
  }
}

function validateBlockingSeverity(report: QaReport, issues: SemanticValidationIssue[]): void {
  for (const finding of report.findings) {
    if (finding.blocking && finding.severity !== "high" && finding.severity !== "critical") {
      issues.push({
        path: `findings.${finding.id}.blocking`,
        message: `Blocking finding "${finding.id}" has severity "${finding.severity}" — only "high" or "critical" may be blocking.`,
      });
    }
  }
}

function validateCompositeScore(report: QaReport, issues: SemanticValidationIssue[]): void {
  const score = report.riskAssessment.compositeScore;
  if (typeof score !== "number" || score < 0 || score > 100 || !Number.isFinite(score)) {
    issues.push({
      path: "riskAssessment.compositeScore",
      message: `Composite score ${score} is out of range (0-100).`,
    });
  }
}

function validateRemediationReferences(report: QaReport, issues: SemanticValidationIssue[]): void {
  const findingIds = new Set(report.findings.map((f) => f.id));

  for (let i = 0; i < report.remediationPlan.length; i++) {
    const item = report.remediationPlan[i]!;
    for (const findingId of item.findingIds) {
      if (!findingIds.has(findingId)) {
        issues.push({
          path: `remediationPlan.${i}.findingIds`,
          message: `Remediation reference "${findingId}" not found in report findings.`,
        });
      }
    }
  }
}
