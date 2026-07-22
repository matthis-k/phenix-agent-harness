/**
 * Phenix QA — Report building, gate calculation, and scoring.
 *
 * This module builds the deterministic report skeleton and provides
 * functions for calculating quality gates and risk scores from evidence.
 */

import type {
  AnalysisCoverage,
  ModelReviewContribution,
  QaEvidence,
  QaFinding,
  QaLevel,
  QaReport,
  QualityGate,
  QualityGateReport,
  ReviewScope,
  RiskAssessment,
  RiskScore,
} from "../contracts/contracts.ts";
import { DEFAULT_QA_CONFIG } from "./config.ts";
import type { QaConfig } from "./types.ts";

const QA_LEVEL_ORDER: readonly QaLevel[] = [
  "level-0-correctness",
  "level-1-metrics",
  "level-2-readability",
  "level-3-patterns",
  "level-4-architecture",
  "level-5-system",
  "level-6-operability",
  "level-7-security",
];

// ── Report Skeleton ──────────────────────────────────────────────────────────

/**
 * Build the deterministic report skeleton with all model-review sections empty.
 */
export function buildReportSkeleton(params: {
  scope: ReviewScope;
  evidence: readonly QaEvidence[];
  findings: readonly QaFinding[];
  coverage: AnalysisCoverage;
  config?: QaConfig;
}): QaReport {
  const config = params.config ?? DEFAULT_QA_CONFIG;
  const now = new Date().toISOString();

  const gates = calculateGates(params.findings, params.coverage, config);

  // Build empty risk scores that the model can fill
  const emptyRiskScore = (name: string, evidenceIds: string[]): RiskScore => ({
    name,
    value: 0,
    confidence: "low",
    rationale: "Not yet assessed.",
    evidenceIds,
    unavailableInputs: params.coverage.unavailableAnalyzers,
  });

  const riskAssessment: RiskAssessment = {
    complexityRisk: emptyRiskScore(
      "Local Complexity Risk",
      evidenceIdsForSource(params.evidence, "metric"),
    ),
    readabilityRisk: emptyRiskScore(
      "Readability Risk",
      evidenceIdsForSource(params.evidence, "model-review"),
    ),
    patternConsistencyRisk: emptyRiskScore(
      "Pattern Consistency Risk",
      evidenceIdsForSource(params.evidence, "structural-rule"),
    ),
    architectureRisk: emptyRiskScore(
      "Architecture Risk",
      evidenceIdsForSource(params.evidence, "dependency-graph"),
    ),
    integrationRisk: emptyRiskScore("System Integration Risk", []),
    operationalRisk: emptyRiskScore("Operational Risk", []),
    securityRisk: emptyRiskScore(
      "Security Risk",
      evidenceIdsForSource(params.evidence, "security-tool"),
    ),
    changeRisk: emptyRiskScore(
      "Change Risk",
      evidenceIdsForSource(params.evidence, "version-control"),
    ),
    compositeScore: 0,
  };

  const overallResult = determineOverallResult(gates);
  const blockingIssues = params.findings
    .filter((finding) => finding.blocking)
    .map((finding) => finding.id);

  return {
    scope: params.scope,
    generatedAt: now,
    executiveSummary: {
      overallResult,
      blockingIssues,
      highestRiskLevel: highestRiskLevel(params.findings),
      architectureAssessment: "not-reviewed",
      currentChangeIncreasesDebt: "unknown",
      analysisCoverage: params.coverage,
      unavailableChecks: params.coverage.unavailableAnalyzers,
    },
    qualityGates: gates,
    findings: [...params.findings],
    evidence: [...params.evidence],
    riskAssessment,
    positiveObservations: [],
    remediationPlan: [],
    rawArtifacts: [],
  };
}

// ── Gate Calculation ─────────────────────────────────────────────────────────

export function calculateGates(
  findings: readonly QaFinding[],
  coverage: AnalysisCoverage,
  _config: QaConfig,
): QualityGateReport {
  const correctnessFindings = findings.filter((f) => f.level === "level-0-correctness");
  const metricsFindings = findings.filter((f) => f.level === "level-1-metrics");
  const readabilityFindings = findings.filter((f) => f.level === "level-2-readability");
  const patternFindings = findings.filter((f) => f.level === "level-3-patterns");
  const archFindings = findings.filter((f) => f.level === "level-4-architecture");
  const sysFindings = findings.filter((f) => f.level === "level-5-system");
  const opFindings = findings.filter((f) => f.level === "level-6-operability");
  const secFindings = findings.filter((f) => f.level === "level-7-security");

  return {
    correctness: gateFromFindings(
      "Gate A — Correctness",
      correctnessFindings,
      !coverage.completedAnalyzers.includes("project-native"),
    ),
    changeSafety: gateFromFindings(
      "Gate B — Change Safety",
      [...metricsFindings, ...readabilityFindings],
      !coverage.completedAnalyzers.includes("metrics"),
    ),
    designConsistency: gateFromFindings(
      "Gate C — Design Consistency",
      [...readabilityFindings, ...patternFindings],
      false,
    ),
    architecture: gateFromFindings("Gate D — Architecture", archFindings, false),
    productionReadiness: gateFromFindings(
      "Gate E — Production Readiness",
      [...sysFindings, ...opFindings, ...secFindings],
      false,
    ),
  };
}

function gateFromFindings(
  name: string,
  findings: readonly QaFinding[],
  notRun: boolean,
): QualityGate {
  if (notRun) {
    return {
      name,
      result: "NOT_RUN",
      failingFindings: [],
      notes: "Required analyzer unavailable.",
    };
  }
  if (findings.length === 0) {
    return { name, result: "PASS", failingFindings: [], notes: "" };
  }

  const blocking = findings.filter((f) => f.blocking);
  const review = findings.filter(
    (f) => !f.blocking && (f.severity === "high" || f.severity === "critical"),
  );

  if (blocking.length > 0) {
    return {
      name,
      result: "FAIL",
      failingFindings: blocking.map((f) => f.id),
      notes: `${blocking.length} blocking finding(s).`,
    };
  }
  if (review.length > 0) {
    return {
      name,
      result: "REVIEW",
      failingFindings: review.map((f) => f.id),
      notes: `${review.length} finding(s) require review.`,
    };
  }
  return {
    name,
    result: "PASS",
    failingFindings: [],
    notes: `${findings.length} advisory finding(s).`,
  };
}

function determineOverallResult(gates: QualityGateReport): "PASS" | "REVIEW" | "FAIL" {
  if (
    gates.correctness.result === "FAIL" ||
    gates.architecture.result === "FAIL" ||
    gates.productionReadiness.result === "FAIL"
  ) {
    return "FAIL";
  }
  if (
    gates.changeSafety.result === "REVIEW" ||
    gates.designConsistency.result === "REVIEW" ||
    gates.architecture.result === "REVIEW" ||
    gates.productionReadiness.result === "REVIEW"
  ) {
    return "REVIEW";
  }
  const anyNotRun =
    gates.correctness.result === "NOT_RUN" || gates.changeSafety.result === "NOT_RUN";
  if (anyNotRun) return "REVIEW";
  return "PASS";
}

// ── Risk Scoring ─────────────────────────────────────────────────────────────

export function calculateRiskScores(
  evidence: readonly QaEvidence[],
  findings: readonly QaFinding[],
): RiskAssessment {
  const evidenceIdsForLevel = (level: string): string[] =>
    evidence.filter((e) => e.level === level).map((e) => e.id);

  const findingSeverityToValue = (
    findings: readonly QaFinding[],
  ): { value: number; evidenceIds: string[] } => {
    if (findings.length === 0) return { value: 0, evidenceIds: [] };
    const values = findings.map((f) => {
      switch (f.severity) {
        case "critical":
          return 90;
        case "high":
          return 70;
        case "medium":
          return 50;
        case "low":
          return 25;
        case "info":
          return 5;
        default:
          return 30;
      }
    });
    // Average with a ceiling effect for multiple findings
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const penalty = Math.min(values.length * 2, 20); // up to +20 for volume
    const clamped = Math.min(Math.round(avg + penalty), 100);
    return {
      value: clamped,
      evidenceIds: findings.flatMap((f) => [...f.evidenceIds]),
    };
  };

  const makeScore = (
    name: string,
    levelFindings: readonly QaFinding[],
    fallbackEvidenceIds: readonly string[],
    unavailableInputs: readonly string[],
  ): RiskScore => {
    const scored = findingSeverityToValue(levelFindings);
    return {
      name,
      value: scored.value,
      confidence:
        scored.evidenceIds.length > 0 && unavailableInputs.length === 0
          ? "high"
          : scored.evidenceIds.length > 0
            ? "medium"
            : "low",
      rationale:
        scored.value > 0 ? `Based on ${levelFindings.length} finding(s).` : "No issues detected.",
      evidenceIds: scored.evidenceIds.length > 0 ? scored.evidenceIds : [...fallbackEvidenceIds],
      unavailableInputs: [...unavailableInputs],
    };
  };

  const findingsByLevel = (level: string) => findings.filter((f) => f.level === level);

  const complexityRisk = makeScore(
    "Local Complexity Risk",
    findingsByLevel("level-1-metrics"),
    evidenceIdsForLevel("level-1-metrics"),
    [],
  );
  const readabilityRisk = makeScore(
    "Readability Risk",
    findingsByLevel("level-2-readability"),
    [],
    [],
  );
  const patternConsistencyRisk = makeScore(
    "Pattern Consistency Risk",
    findingsByLevel("level-3-patterns"),
    evidenceIdsForLevel("level-3-patterns"),
    [],
  );
  const architectureRisk = makeScore(
    "Architecture Risk",
    findingsByLevel("level-4-architecture"),
    evidenceIdsForLevel("level-4-architecture"),
    [],
  );
  const integrationRisk = makeScore(
    "System Integration Risk",
    findingsByLevel("level-5-system"),
    [],
    [],
  );
  const operationalRisk = makeScore(
    "Operational Risk",
    findingsByLevel("level-6-operability"),
    [],
    [],
  );
  const securityRisk = makeScore(
    "Security Risk",
    findingsByLevel("level-7-security"),
    evidenceIdsForLevel("level-7-security"),
    [],
  );
  const changeRisk = makeScore(
    "Change Risk",
    findings.filter((f) => f.introducedByCurrentChange === true),
    evidenceIdsForLevel("level-1-metrics"),
    [],
  );

  const compositeScore = calculateCompositeScore({
    complexityRisk,
    readabilityRisk,
    patternConsistencyRisk,
    architectureRisk,
    integrationRisk,
    operationalRisk,
    securityRisk,
    changeRisk,
  });

  return {
    complexityRisk,
    readabilityRisk,
    patternConsistencyRisk,
    architectureRisk,
    integrationRisk,
    operationalRisk,
    securityRisk,
    changeRisk,
    compositeScore,
  };
}

export function calculateCompositeScore(scores: {
  complexityRisk: RiskScore;
  readabilityRisk: RiskScore;
  patternConsistencyRisk: RiskScore;
  architectureRisk: RiskScore;
  integrationRisk: RiskScore;
  operationalRisk: RiskScore;
  securityRisk: RiskScore;
  changeRisk: RiskScore;
}): number {
  const weights = {
    complexityRisk: 0.15,
    readabilityRisk: 0.1,
    patternConsistencyRisk: 0.1,
    architectureRisk: 0.2,
    integrationRisk: 0.15,
    operationalRisk: 0.1,
    securityRisk: 0.1,
    changeRisk: 0.1,
  };

  let weighted = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const score = (scores as Record<string, RiskScore>)[key];
    weighted += (score?.value ?? 0) * weight;
  }

  return Math.min(Math.round(weighted), 100);
}

// ── Model Contribution Merging ───────────────────────────────────────────────

export function mergeModelContribution(
  skeleton: QaReport,
  contribution: ModelReviewContribution,
): QaReport {
  // Merge findings (deduplicate by id)
  const existingIds = new Set(skeleton.findings.map((f) => f.id));
  const newFindings = contribution.findings.filter((f) => !existingIds.has(f.id));

  const merged: QaReport = {
    ...skeleton,
    findings: [...skeleton.findings, ...newFindings],
    riskAssessment: {
      ...skeleton.riskAssessment,
      readabilityRisk: contribution.readabilityRisk ?? skeleton.riskAssessment.readabilityRisk,
      patternConsistencyRisk:
        contribution.patternConsistencyRisk ?? skeleton.riskAssessment.patternConsistencyRisk,
      architectureRisk: contribution.architectureRisk ?? skeleton.riskAssessment.architectureRisk,
      integrationRisk: contribution.integrationRisk ?? skeleton.riskAssessment.integrationRisk,
      operationalRisk: contribution.operationalRisk ?? skeleton.riskAssessment.operationalRisk,
      securityRisk: contribution.securityRisk ?? skeleton.riskAssessment.securityRisk,
    },
    positiveObservations: [...skeleton.positiveObservations, ...contribution.positiveObservations],
    remediationPlan: [...skeleton.remediationPlan, ...contribution.remediationPlan],
  };

  // Recalculate composite score
  merged.riskAssessment = {
    ...merged.riskAssessment,
    compositeScore: calculateCompositeScore(merged.riskAssessment),
  };

  // Recalculate gates
  merged.qualityGates = calculateGates(
    merged.findings,
    merged.executiveSummary.analysisCoverage,
    DEFAULT_QA_CONFIG,
  );

  const introduced = merged.findings.map((finding) => finding.introducedByCurrentChange);
  const currentChangeIncreasesDebt = introduced.some((value) => value === true)
    ? true
    : introduced.length > 0 && introduced.every((value) => value === false)
      ? false
      : "unknown";

  // Recompute every finding-derived executive summary field after merging.
  merged.executiveSummary = {
    ...merged.executiveSummary,
    overallResult: determineOverallResult(merged.qualityGates),
    blockingIssues: merged.findings
      .filter((finding) => finding.blocking)
      .map((finding) => finding.id),
    highestRiskLevel: highestRiskLevel(merged.findings),
    currentChangeIncreasesDebt,
    architectureAssessment: contribution.architectureRisk
      ? contribution.architectureRisk.value > 40
        ? "inconsistent"
        : "consistent"
      : merged.executiveSummary.architectureAssessment,
  };

  return merged;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function highestRiskLevel(findings: readonly QaFinding[]): QaLevel | undefined {
  const levelsWithFindings = new Set(findings.map((finding) => finding.level));
  return QA_LEVEL_ORDER.findLast((level) => levelsWithFindings.has(level));
}

function evidenceIdsForSource(evidence: readonly QaEvidence[], source: string): string[] {
  return evidence.filter((e) => e.source === source).map((e) => e.id);
}
