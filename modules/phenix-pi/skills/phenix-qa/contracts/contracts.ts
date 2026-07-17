/**
 * Phenix QA — Runtime-validatable contract types and schemas.
 *
 * Uses TypeBox for runtime validation. Derives TypeScript types via Static<>.
 * Cross-reference validation is handled in the separate semantic-validation pass.
 */

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

// ── QA Levels ───────────────────────────────────────────────────────────────

export const QA_LEVELS = [
  "level-0-correctness",
  "level-1-metrics",
  "level-2-readability",
  "level-3-patterns",
  "level-4-architecture",
  "level-5-system",
  "level-6-operability",
  "level-7-security",
] as const;

export const QaLevelSchema = Type.Union(QA_LEVELS.map((level) => Type.Literal(level)));

export type QaLevel = Static<typeof QaLevelSchema>;

// ── Evidence ─────────────────────────────────────────────────────────────────

export const EVIDENCE_SOURCES = [
  "compiler",
  "test",
  "metric",
  "structural-rule",
  "dependency-graph",
  "duplication",
  "coverage",
  "version-control",
  "security-tool",
  "model-review",
  "combined",
] as const;

export const EvidenceSourceSchema = Type.Union(
  EVIDENCE_SOURCES.map((source) => Type.Literal(source)),
);

export type EvidenceSource = Static<typeof EvidenceSourceSchema>;

export const SourceLocationSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    startLine: Type.Optional(Type.Number({ minimum: 1 })),
    endLine: Type.Optional(Type.Number({ minimum: 1 })),
    symbol: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
);

export type SourceLocation = Static<typeof SourceLocationSchema>;

export const QaMetricSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    value: Type.Number(),
    threshold: Type.Optional(Type.Number()),
    unit: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
);

export const QaEvidenceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    level: QaLevelSchema,
    source: EvidenceSourceSchema,
    tool: Type.Optional(Type.String()),
    ruleId: Type.Optional(Type.String()),
    category: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    locations: Type.Array(SourceLocationSchema),
    metric: Type.Optional(QaMetricSchema),
    rawReference: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
);

export type QaEvidence = Static<typeof QaEvidenceSchema>;

// ── Findings ─────────────────────────────────────────────────────────────────

export const FINDING_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export const FindingSeveritySchema = Type.Union(FINDING_SEVERITIES.map((s) => Type.Literal(s)));

export type FindingSeverity = Static<typeof FindingSeveritySchema>;

export const FINDING_CONFIDENCES = ["low", "medium", "high"] as const;

export const FindingConfidenceSchema = Type.Union(FINDING_CONFIDENCES.map((c) => Type.Literal(c)));

export type FindingConfidence = Static<typeof FindingConfidenceSchema>;

export const REMEDIATION_SCOPES = [
  "local",
  "small-refactor",
  "module-refactor",
  "architecture-change",
  "system-change",
] as const;

export const RemediationScopeSchema = Type.Union(REMEDIATION_SCOPES.map((s) => Type.Literal(s)));

export type RemediationScope = Static<typeof RemediationScopeSchema>;

export const QaFindingSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    level: QaLevelSchema,
    severity: FindingSeveritySchema,
    confidence: FindingConfidenceSchema,
    title: Type.String({ minLength: 1 }),
    explanation: Type.String({ minLength: 1 }),
    evidenceIds: Type.Array(Type.String({ minLength: 1 })),
    locations: Type.Array(SourceLocationSchema),
    impact: Type.String({ minLength: 1 }),
    recommendation: Type.String({ minLength: 1 }),
    remediationScope: RemediationScopeSchema,
    introducedByCurrentChange: Type.Union([
      Type.Literal(true),
      Type.Literal(false),
      Type.Literal("unknown"),
    ]),
    blocking: Type.Boolean(),
  },
  {
    additionalProperties: false,
  },
);

export type QaFinding = Static<typeof QaFindingSchema>;

// ── Risk Scores ──────────────────────────────────────────────────────────────

export const RiskScoreSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    value: Type.Number({ minimum: 0, maximum: 100 }),
    confidence: FindingConfidenceSchema,
    rationale: Type.String({ minLength: 1 }),
    evidenceIds: Type.Array(Type.String({ minLength: 1 })),
    unavailableInputs: Type.Array(Type.String()),
  },
  {
    additionalProperties: false,
  },
);

export type RiskScore = Static<typeof RiskScoreSchema>;

export const RiskAssessmentSchema = Type.Object(
  {
    complexityRisk: RiskScoreSchema,
    readabilityRisk: RiskScoreSchema,
    patternConsistencyRisk: RiskScoreSchema,
    architectureRisk: RiskScoreSchema,
    integrationRisk: RiskScoreSchema,
    operationalRisk: RiskScoreSchema,
    securityRisk: RiskScoreSchema,
    changeRisk: RiskScoreSchema,
    compositeScore: Type.Number({ minimum: 0, maximum: 100 }),
  },
  {
    additionalProperties: false,
  },
);

export type RiskAssessment = Static<typeof RiskAssessmentSchema>;

// ── Quality Gates ────────────────────────────────────────────────────────────

export const GATE_RESULTS = ["PASS", "FAIL", "REVIEW", "NOT_RUN"] as const;

export const GateResultSchema = Type.Union(GATE_RESULTS.map((r) => Type.Literal(r)));

export type GateResult = Static<typeof GateResultSchema>;

export const QualityGateSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    result: GateResultSchema,
    failingFindings: Type.Array(Type.String()),
    notes: Type.String(),
  },
  {
    additionalProperties: false,
  },
);

export type QualityGate = Static<typeof QualityGateSchema>;

export const QualityGateReportSchema = Type.Object(
  {
    correctness: QualityGateSchema,
    changeSafety: QualityGateSchema,
    designConsistency: QualityGateSchema,
    architecture: QualityGateSchema,
    productionReadiness: QualityGateSchema,
  },
  {
    additionalProperties: false,
  },
);

export type QualityGateReport = Static<typeof QualityGateReportSchema>;

// ── Review Scope ─────────────────────────────────────────────────────────────

export const REVIEW_SCOPE_KINDS = [
  "diff",
  "files",
  "module",
  "repository",
  "architecture",
] as const;

export const ReviewScopeKindSchema = Type.Union(REVIEW_SCOPE_KINDS.map((k) => Type.Literal(k)));

export type ReviewScopeKind = Static<typeof ReviewScopeKindSchema>;

export const ReviewScopeSchema = Type.Object(
  {
    kind: ReviewScopeKindSchema,
    baseRevision: Type.Optional(Type.String()),
    targetRevision: Type.Optional(Type.String()),
    files: Type.Optional(Type.Array(Type.String())),
    module: Type.Optional(Type.String()),
    description: Type.String(),
  },
  {
    additionalProperties: false,
  },
);

export type ReviewScope = Static<typeof ReviewScopeSchema>;

// ── Analysis Coverage ────────────────────────────────────────────────────────

export const AnalysisCoverageSchema = Type.Object(
  {
    requestedAnalyzers: Type.Array(Type.String()),
    completedAnalyzers: Type.Array(Type.String()),
    unavailableAnalyzers: Type.Array(Type.String()),
    failedAnalyzers: Type.Array(Type.String()),
    coveredFiles: Type.Number({ minimum: 0 }),
    totalScopedFiles: Type.Number({ minimum: 0 }),
    coveredLanguages: Type.Array(Type.String()),
    uncoveredLanguages: Type.Array(Type.String()),
  },
  {
    additionalProperties: false,
  },
);

export type AnalysisCoverage = Static<typeof AnalysisCoverageSchema>;

// ── Architecture Assessment ──────────────────────────────────────────────────

export const ARCHITECTURE_ASSESSMENTS = [
  "consistent",
  "inconsistent",
  "uncertain",
  "not-reviewed",
] as const;

export const ArchitectureAssessmentSchema = Type.Union(
  ARCHITECTURE_ASSESSMENTS.map((a) => Type.Literal(a)),
);

export type ArchitectureAssessment = Static<typeof ArchitectureAssessmentSchema>;

// ── Executive Summary ────────────────────────────────────────────────────────

export const ExecutiveSummarySchema = Type.Object(
  {
    overallResult: Type.Union([Type.Literal("PASS"), Type.Literal("REVIEW"), Type.Literal("FAIL")]),
    blockingIssues: Type.Array(Type.String()),
    highestRiskLevel: Type.Optional(QaLevelSchema),
    architectureAssessment: ArchitectureAssessmentSchema,
    currentChangeIncreasesDebt: Type.Union([
      Type.Literal(true),
      Type.Literal(false),
      Type.Literal("unknown"),
    ]),
    analysisCoverage: AnalysisCoverageSchema,
    unavailableChecks: Type.Array(Type.String()),
  },
  {
    additionalProperties: false,
  },
);

// ── Full Report ──────────────────────────────────────────────────────────────

export const RemediationPlanItemSchema = Type.Object(
  {
    priority: Type.Number({ minimum: 1 }),
    category: Type.String({ minLength: 1 }),
    findingIds: Type.Array(Type.String()),
    description: Type.String({ minLength: 1 }),
  },
  {
    additionalProperties: false,
  },
);

export const QaReportSchema = Type.Object(
  {
    scope: ReviewScopeSchema,
    generatedAt: Type.String({ minLength: 1 }),
    executiveSummary: ExecutiveSummarySchema,
    qualityGates: QualityGateReportSchema,
    findings: Type.Array(QaFindingSchema),
    evidence: Type.Array(QaEvidenceSchema),
    riskAssessment: RiskAssessmentSchema,
    positiveObservations: Type.Array(Type.String()),
    remediationPlan: Type.Array(RemediationPlanItemSchema),
    rawArtifacts: Type.Array(Type.String()),
  },
  {
    additionalProperties: false,
  },
);

export type QaReport = Static<typeof QaReportSchema>;

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validation result following the project's ContractValidation shape.
 */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly violations: readonly ContractViolation[];
    };

export interface ContractViolation {
  readonly path: string;
  readonly message: string;
}

/**
 * Compiles and checks a value against a TypeBox schema.
 */
interface CompileResult {
  Check(value: unknown): boolean;
  Errors(value: unknown): Iterable<{
    instancePath?: string;
    path?: string;
    message?: string;
  }>;
}

function compileAndCheck<T>(
  schema: unknown,
  value: unknown,
): { ok: true; decoded: T } | { ok: false; violations: ContractViolation[] } {
  try {
    const compiled = Compile(schema) as CompileResult;

    if (compiled.Check(value)) {
      return { ok: true, decoded: value as T };
    }
    const violations = [...compiled.Errors(value)].slice(0, 20).map((e) => ({
      path: (e.instancePath ?? e.path ?? "").replace(/^\//, "").replaceAll("/", ".") || "root",
      message: e.message ?? "validation failed",
    }));
    return { ok: false, violations };
  } catch (error) {
    return {
      ok: false,
      violations: [
        {
          path: "root",
          message: `schema compilation failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

function makeValidator<T>(schema: unknown): (value: unknown) => ValidationResult<T> {
  return (value: unknown): ValidationResult<T> => {
    const result = compileAndCheck<T>(schema, value);
    if (result.ok) {
      return { ok: true, value: result.decoded };
    }
    return {
      ok: false,
      summary: result.violations.map((v) => `${v.path}: ${v.message}`).join("; "),
      violations: result.violations,
    };
  };
}

function makeAsserter<T>(
  validator: (value: unknown) => ValidationResult<T>,
): (value: unknown) => T {
  return (value: unknown): T => {
    const result = validator(value);
    if (!result.ok) {
      throw new Error(
        `Schema validation failed: ${result.summary}\n${result.violations.map((v) => `  ${v.path}: ${v.message}`).join("\n")}`,
      );
    }
    return result.value;
  };
}

export const validateQaEvidence = makeValidator<QaEvidence>(QaEvidenceSchema);
export const validateQaFinding = makeValidator<QaFinding>(QaFindingSchema);
export const validateQaReport = makeValidator<QaReport>(QaReportSchema);
export const validateQaEvidenceArray = makeValidator<readonly QaEvidence[]>(
  Type.Array(QaEvidenceSchema),
);
export const validateQaFindingArray = makeValidator<readonly QaFinding[]>(
  Type.Array(QaFindingSchema),
);
export const validateRiskAssessment = makeValidator<RiskAssessment>(RiskAssessmentSchema);
export const validateReviewScope = makeValidator<ReviewScope>(ReviewScopeSchema);
export const validateAnalysisCoverage = makeValidator<AnalysisCoverage>(AnalysisCoverageSchema);

export const assertQaReport = makeAsserter(validateQaReport);
export const assertQaEvidence = makeAsserter(validateQaEvidence);
export const assertQaFinding = makeAsserter(validateQaFinding);

// ── Model Review Contribution ────────────────────────────────────────────────

/**
 * Schema for the model-assisted review contribution.
 * The model fills only these fields; the runtime merges them into the
 * deterministic skeleton.
 */
export const ModelReviewContributionSchema = Type.Object(
  {
    findings: Type.Array(QaFindingSchema),
    readabilityRisk: Type.Optional(RiskScoreSchema),
    patternConsistencyRisk: Type.Optional(RiskScoreSchema),
    architectureRisk: Type.Optional(RiskScoreSchema),
    integrationRisk: Type.Optional(RiskScoreSchema),
    operationalRisk: Type.Optional(RiskScoreSchema),
    securityRisk: Type.Optional(RiskScoreSchema),
    positiveObservations: Type.Array(Type.String()),
    remediationPlan: Type.Array(RemediationPlanItemSchema),
  },
  {
    additionalProperties: false,
  },
);

export type ModelReviewContribution = Static<typeof ModelReviewContributionSchema>;

export const validateModelReviewContribution = makeValidator<ModelReviewContribution>(
  ModelReviewContributionSchema,
);
