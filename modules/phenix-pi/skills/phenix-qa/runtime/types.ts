/**
 * Phenix QA — Shared runtime types.
 *
 * These are plain TypeScript interfaces (not runtime-validated TypeBox schemas).
 * Schema-validated types live in contracts/contracts.ts.
 */

import type {
  QaLevel,
  QaEvidence,
  QaFinding,
  ReviewScope,
  QaReport,
  RiskScore,
  RiskAssessment,
  QualityGateReport,
  AnalysisCoverage,
  ArchitectureAssessment,
  ModelReviewContribution,
} from "../contracts/contracts.ts";

export type {
  QaLevel,
  QaEvidence,
  QaFinding,
  ReviewScope,
  QaReport,
  RiskScore,
  RiskAssessment,
  QualityGateReport,
  AnalysisCoverage,
  ArchitectureAssessment,
  ModelReviewContribution,
};

// ── Configuration ────────────────────────────────────────────────────────────

export interface QaConfig {
  readonly enabledAnalyzers: readonly string[];
  readonly requiredAnalyzers: readonly string[];

  readonly timeouts: {
    readonly defaultMs: number;
    readonly byAnalyzer?: Readonly<Record<string, number>>;
  };

  readonly ignore: {
    readonly paths: readonly string[];
    readonly generatedPaths: readonly string[];
    readonly vendorPaths: readonly string[];
  };

  readonly thresholds: {
    readonly cyclomaticComplexity?: number;
    readonly cognitiveComplexity?: number;
    readonly maximumNesting?: number;
    readonly functionLogicalLines?: number;
    readonly fileLogicalLines?: number;
    readonly booleanTerms?: number;
    readonly duplicationPercent?: number;
  };

  readonly structuralRuleDirectories: readonly string[];

  readonly output: {
    readonly artifactDirectory: string;
    readonly writeJson: boolean;
    readonly writeText: boolean;
  };
}

// ── Analyzer Types ───────────────────────────────────────────────────────────

export interface QaAnalyzerContext {
  readonly cwd: string;
  readonly scope: ReviewScope;
  readonly artifactDirectory: string;
  readonly signal?: AbortSignal;
  readonly config: QaConfig;
}

export interface QaAnalyzerAvailability {
  readonly available: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly reason?: string;
}

export type AnalyzerStatus =
  | "completed"
  | "unavailable"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "not-applicable";

export interface QaAnalyzerResult {
  readonly analyzer: string;
  readonly status: AnalyzerStatus;
  readonly evidence: readonly QaEvidence[];
  readonly artifacts: readonly string[];
  readonly diagnostics: readonly string[];
  readonly durationMs: number;
}

export interface QaAnalyzer {
  readonly id: string;
  readonly categories: readonly string[];

  checkAvailability(
    context: QaAnalyzerContext,
  ): Promise<QaAnalyzerAvailability>;

  run(context: QaAnalyzerContext): Promise<QaAnalyzerResult>;
}

// ── Process Execution ────────────────────────────────────────────────────────

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface ProcessRunner {
  exec(
    command: string,
    args: readonly string[],
    options?: {
      cwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ProcessResult>;
}

// ── Scope ────────────────────────────────────────────────────────────────────

export interface ScopeFiles {
  readonly files: readonly string[];
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly renamed: readonly string[];
  readonly deleted: readonly string[];
}

// ── Repository Guidance ──────────────────────────────────────────────────────

export interface RepositoryGuidance {
  readonly cwd: string;
  readonly projectRoot: string;
  readonly packageManagers: readonly string[];
  readonly buildCommands: readonly string[];
  readonly testCommands: readonly string[];
  readonly lintCommands: readonly string[];
  readonly formatCheckCommands: readonly string[];
  readonly guidanceDocs: readonly string[];
  readonly architectureDocs: readonly string[];
}

// ── Model-owner fields ───────────────────────────────────────────────────────

/**
 * Fields that a model-assisted review may fill.
 */
export const MODEL_OWNED_FIELDS = [
  "readabilityRisk",
  "patternConsistencyRisk",
  "architectureRisk",
  "integrationRisk",
  "operationalRisk",
  "securityRisk",
  "positiveObservations",
  "remediationPlan",
] as const;
