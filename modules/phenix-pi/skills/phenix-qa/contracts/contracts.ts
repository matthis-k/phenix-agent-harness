/**
 * Phenix QA — Contract types for evidence and findings.
 *
 * These types define the normalized schema that all QA tools and
 * model-assisted reviews must conform to.
 */

// ── QA Levels ───────────────────────────────────────────────────────────────

export type QaLevel =
  | "level-0-correctness"
  | "level-1-metrics"
  | "level-2-readability"
  | "level-3-patterns"
  | "level-4-architecture"
  | "level-5-system"
  | "level-6-operability"
  | "level-7-security";

// ── Evidence ─────────────────────────────────────────────────────────────────

export type EvidenceSource =
  | "compiler"
  | "test"
  | "metric"
  | "structural-rule"
  | "dependency-graph"
  | "duplication"
  | "coverage"
  | "version-control"
  | "security-tool"
  | "model-review"
  | "combined";

export interface SourceLocation {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly symbol?: string;
}

export interface QaEvidence {
  readonly id: string;
  readonly level: QaLevel;
  readonly source: EvidenceSource;
  readonly tool?: string;
  readonly ruleId?: string;
  readonly category: string;
  readonly message: string;
  readonly locations: readonly SourceLocation[];
  readonly metric?: {
    readonly name: string;
    readonly value: number;
    readonly threshold?: number;
    readonly unit?: string;
  };
  readonly rawReference?: string;
}

// ── Findings ─────────────────────────────────────────────────────────────────

export type FindingSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

export type FindingConfidence =
  | "low"
  | "medium"
  | "high";

export type RemediationScope =
  | "local"
  | "small-refactor"
  | "module-refactor"
  | "architecture-change"
  | "system-change";

export interface QaFinding {
  readonly id: string;
  readonly level: QaLevel;
  readonly severity: FindingSeverity;
  readonly confidence: FindingConfidence;
  readonly title: string;
  readonly explanation: string;
  readonly evidenceIds: readonly string[];
  readonly locations: readonly SourceLocation[];
  readonly impact: string;
  readonly recommendation: string;
  readonly remediationScope: RemediationScope;
  readonly introducedByCurrentChange: true | false | "unknown";
  readonly blocking: boolean;
}

// ── Risk Scores ──────────────────────────────────────────────────────────────

export interface RiskScore {
  readonly name: string;
  readonly value: number; // 0-100
  readonly confidence: FindingConfidence;
  readonly rationale: string;
}

export interface RiskAssessment {
  readonly complexityRisk: RiskScore;
  readonly readabilityRisk: RiskScore;
  readonly patternConsistencyRisk: RiskScore;
  readonly architectureRisk: RiskScore;
  readonly integrationRisk: RiskScore;
  readonly operationalRisk: RiskScore;
  readonly securityRisk: RiskScore;
  readonly changeRisk: RiskScore;
  /** Composite score (0-100), weighted by repository type. */
  readonly compositeScore: number;
}

// ── Quality Gates ────────────────────────────────────────────────────────────

export type GateResult = "PASS" | "FAIL" | "REVIEW" | "NOT_RUN";

export interface QualityGate {
  readonly name: string;
  readonly result: GateResult;
  readonly failingFindings: readonly string[]; // finding IDs
  readonly notes: string;
}

export interface QualityGateReport {
  readonly correctness: QualityGate;
  readonly changeSafety: QualityGate;
  readonly designConsistency: QualityGate;
  readonly architecture: QualityGate;
  readonly productionReadiness: QualityGate;
}

// ── Review Scope ─────────────────────────────────────────────────────────────

export type ReviewScopeKind =
  | "diff"
  | "files"
  | "module"
  | "repository"
  | "architecture";

export interface ReviewScope {
  readonly kind: ReviewScopeKind;
  readonly baseRevision?: string;
  readonly targetRevision?: string;
  readonly files?: readonly string[];
  readonly module?: string;
  readonly description: string;
}

// ── Full Report ──────────────────────────────────────────────────────────────

export interface QaReport {
  readonly scope: ReviewScope;
  readonly generatedAt: string;
  readonly executiveSummary: {
    readonly overallResult: "PASS" | "REVIEW" | "FAIL";
    readonly blockingIssues: readonly string[];
    readonly highestRiskLevel: QaLevel;
    readonly architectureConsistent: boolean;
    readonly currentChangeIncreasesDebt: boolean | "unknown";
    readonly analysisCoverage: string;
    readonly unavailableChecks: readonly string[];
  };
  readonly qualityGates: QualityGateReport;
  readonly findings: readonly QaFinding[];
  readonly evidence: readonly QaEvidence[];
  readonly riskAssessment: RiskAssessment;
  readonly positiveObservations: readonly string[];
  readonly remediationPlan: readonly {
    readonly priority: number;
    readonly category: string;
    readonly findingIds: readonly string[];
    readonly description: string;
  }[];
  readonly rawArtifacts: readonly string[]; // paths to raw tool outputs
}
