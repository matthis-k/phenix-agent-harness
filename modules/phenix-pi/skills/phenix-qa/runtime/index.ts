/**
 * Phenix QA — Runtime entry point.
 *
 * Main QA pipeline: scope → discovery → analysis → report → validate.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AnalysisCoverage,
  QaEvidence,
  QaFinding,
  QaReport,
  ReviewScope,
} from "../contracts/contracts.ts";
import { validateModelReviewContribution, validateQaReport } from "../contracts/contracts.ts";
import { ALL_ANALYZERS, getAnalyzers } from "./analyzers/registry.ts";
import { ensureArtifactDir, writeJsonArtifact, writeTextArtifact } from "./artifacts.ts";
import { checkAllAvailability } from "./availability.ts";
import { DEFAULT_QA_CONFIG, discoverRepoConfig, mergeConfig } from "./config.ts";
import { discoverGuidance } from "./guidance.ts";
import { makeFinding, resetIdCounter } from "./normalize.ts";
import { DEFAULT_PROCESS_RUNNER } from "./process.ts";
import { renderTextReport } from "./render-text.ts";
import { buildReportSkeleton, calculateRiskScores, mergeModelContribution } from "./report.ts";
import { isIgnoredPath, resolveScopeFiles } from "./scope.ts";
import { validateReportSemantics } from "./semantic-validation.ts";
import type { QaAnalyzerResult, QaConfig } from "./types.ts";

// ── Public API ───────────────────────────────────────────────────────────────

export interface QaReviewOptions {
  scope: ReviewScope;
  config?: Partial<QaConfig>;
  cwd?: string;
  signal?: AbortSignal;
  /** Caller-owned output override. Repository configuration cannot grant external writes. */
  outputDirectory?: string;
  /** Permit an explicit caller output path outside cwd. False by default. */
  allowExternalOutput?: boolean;
}

export interface QaReviewResult {
  report: QaReport;
  artifacts: string[];
  diagnostics: string[];
}

/**
 * Run a complete QA review.
 */
export async function review(options: QaReviewOptions): Promise<QaReviewResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const signal = options.signal;

  resetIdCounter(0);

  // 1. Load configuration
  let config = DEFAULT_QA_CONFIG;
  try {
    const repoConfig = await discoverRepoConfig(
      cwd,
      async (path) => {
        const { readFile: read } = await import("node:fs/promises");
        return read(path, "utf-8");
      },
      async (path) => {
        const { access } = await import("node:fs/promises");
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
    );
    config = mergeConfig(DEFAULT_QA_CONFIG, repoConfig);
  } catch {
    // Use defaults
  }
  config = mergeConfig(config, options.config);

  // 2. Create artifact directory. Repository configuration is always confined
  // to cwd; only the direct caller can explicitly permit an external override.
  const artifactDir = ensureArtifactDir(
    cwd,
    options.outputDirectory ?? config.output.artifactDirectory,
    options.allowExternalOutput === true,
  );

  // 3. Resolve scope files
  const scopeFiles = await resolveScopeFiles(options.scope, cwd, DEFAULT_PROCESS_RUNNER);

  // 4. Filter scope files for ignored paths
  const scopedFiles = scopeFiles.files.filter(
    (f) =>
      !isIgnoredPath(
        f,
        config.ignore.paths,
        config.ignore.generatedPaths,
        config.ignore.vendorPaths,
      ),
  );

  // 5. Discover repository guidance
  const _guidance = discoverGuidance(cwd);

  // 6. Create analyzer context
  const context = {
    cwd,
    scope: options.scope,
    scopedFiles,
    artifactDirectory: artifactDir,
    signal,
    config,
  };

  // 7. Check analyzer availability
  const analyzers = getAnalyzers(config.enabledAnalyzers);
  const availability = await checkAllAvailability(
    analyzers.map((a) => ({ id: a.id, checkAvailability: a.checkAvailability.bind(a) })),
    context,
  );

  const completedAnalyzers: string[] = [];
  const unavailableAnalyzers: string[] = [];
  const failedAnalyzers: string[] = [];

  // 8. Run enabled analyzers
  const allEvidence: QaEvidence[] = [];
  const allFindings: QaFinding[] = [];
  const allArtifacts: string[] = [];
  const allDiagnostics: string[] = [];

  for (const analyzer of analyzers) {
    if (signal?.aborted) break;

    const av = availability.get(analyzer.id);
    if (!av?.available) {
      unavailableAnalyzers.push(analyzer.id);
      allDiagnostics.push(`${analyzer.id}: unavailable (${av?.reason ?? "unknown"})`);
      continue;
    }

    try {
      const result: QaAnalyzerResult = await analyzer.run(context);
      allDiagnostics.push(`${analyzer.id}: ${result.status} (${result.durationMs}ms)`);

      if (result.status === "completed") {
        completedAnalyzers.push(analyzer.id);
        allEvidence.push(...result.evidence);
        // Convert project-native failures into blocking correctness findings
        if (analyzer.id === "project-native") {
          for (const evidence of result.evidence) {
            if (
              evidence.source === "test" &&
              /(?:failed|timed out|could not be executed)/i.test(evidence.message)
            ) {
              allFindings.push(
                makeFinding({
                  level: "level-0-correctness",
                  severity: "high",
                  confidence: "high",
                  title: evidence.category
                    ? `Project-native ${evidence.category} failure`
                    : "Project-native verification failure",
                  explanation: evidence.message,
                  evidenceIds: [evidence.id],
                  impact: "Repository verification command did not pass.",
                  recommendation: "Fix the failing command or adjust the verification setup.",
                  remediationScope: "local",
                  blocking: true,
                }),
              );
            }
          }
        }
        allArtifacts.push(...result.artifacts);
        allDiagnostics.push(...result.diagnostics.map((d) => `  ${d}`));
      } else if (result.status === "failed") {
        failedAnalyzers.push(analyzer.id);
        allDiagnostics.push(...result.diagnostics.map((d) => `  ${d}`));
        // Still collect partial evidence
        allEvidence.push(...result.evidence);
        allArtifacts.push(...result.artifacts);
      } else {
        // timed-out, cancelled, not-applicable, unavailable
        if (result.status === "timed-out" || result.status === "cancelled") {
          failedAnalyzers.push(analyzer.id);
        }
        allDiagnostics.push(...result.diagnostics.map((d) => `  ${d}`));
      }
    } catch (error) {
      failedAnalyzers.push(analyzer.id);
      allDiagnostics.push(
        `${analyzer.id}: error - ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Enforce required analyzers: missing or failed required analyzers become blocking findings
  for (const required of config.requiredAnalyzers) {
    if (!completedAnalyzers.includes(required)) {
      const reason = unavailableAnalyzers.includes(required)
        ? "unavailable"
        : failedAnalyzers.includes(required)
          ? "failed"
          : "not enabled";
      allFindings.push(
        makeFinding({
          level: "level-0-correctness",
          severity: "high",
          confidence: "high",
          title: `Required analyzer ${required} did not complete`,
          explanation: `The required analyzer "${required}" was ${reason}.`,
          evidenceIds: [],
          impact: "A required QA analyzer did not run, leaving a coverage gap that must be closed.",
          recommendation: "Ensure the required analyzer is installed, enabled, and passes.",
          remediationScope: "local",
          blocking: true,
        }),
      );
    }
  }

  // 9. Build analysis coverage
  const coverage: AnalysisCoverage = {
    requestedAnalyzers: config.enabledAnalyzers,
    completedAnalyzers,
    unavailableAnalyzers,
    failedAnalyzers,
    coveredFiles: scopedFiles.length,
    totalScopedFiles: scopeFiles.files.length,
    coveredLanguages: [],
    uncoveredLanguages: [],
  };

  // 10. Build deterministic report skeleton
  const skeleton = buildReportSkeleton({
    scope: options.scope,
    evidence: allEvidence,
    findings: allFindings,
    coverage,
    config,
  });

  // Merge raw artifacts
  const reportWithArtifacts: QaReport = {
    ...skeleton,
    rawArtifacts: allArtifacts,
  };

  // 11. Write JSON report
  if (config.output.writeJson) {
    allArtifacts.push(writeJsonArtifact(artifactDir, "qa-report", reportWithArtifacts));
  }

  // 12. Write text report
  if (config.output.writeText) {
    const text = renderTextReport(reportWithArtifacts);
    allArtifacts.push(writeTextArtifact(artifactDir, "qa-report", text));
  }

  return {
    report: reportWithArtifacts,
    artifacts: allArtifacts,
    diagnostics: allDiagnostics,
  };
}

/**
 * Validate and merge a model-assisted review contribution into a skeleton report.
 */
export function submitModelReview(
  skeleton: QaReport,
  contribution: unknown,
):
  | { ok: true; report: QaReport }
  | { ok: false; summary: string; violations: readonly { path: string; message: string }[] } {
  const validation = validateModelReviewContribution(contribution);
  if (!validation.ok) {
    return {
      ok: false,
      summary: validation.summary,
      violations: validation.violations,
    };
  }

  // Merge and recalculate
  const merged = mergeModelContribution(skeleton, validation.value);

  // Recalculate risk scores
  merged.riskAssessment = calculateRiskScores(merged.evidence, merged.findings);

  // Final semantic validation
  const semantics = validateReportSemantics(merged);
  if (!semantics.ok) {
    return {
      ok: false,
      summary: `Semantic validation failed: ${semantics.issues.length} issue(s).`,
      violations: semantics.issues,
    };
  }

  // Final schema validation
  const finalCheck = validateQaReport(merged);
  if (!finalCheck.ok) {
    return {
      ok: false,
      summary: `Schema validation failed: ${finalCheck.summary}`,
      violations: finalCheck.violations,
    };
  }

  return { ok: true, report: merged };
}

/**
 * Validate a QA report from a file or object.
 */
export function validateReport(
  value: unknown,
):
  | { ok: true; report: QaReport }
  | { ok: false; summary: string; violations: readonly { path: string; message: string }[] } {
  const schemaResult = validateQaReport(value);
  if (!schemaResult.ok) {
    return {
      ok: false,
      summary: `Schema validation failed: ${schemaResult.summary}`,
      violations: schemaResult.violations,
    };
  }

  const semantics = validateReportSemantics(schemaResult.value);
  if (!semantics.ok) {
    return {
      ok: false,
      summary: `Semantic validation failed: ${semantics.issues.length} issue(s).`,
      violations: semantics.issues,
    };
  }

  return { ok: true, report: schemaResult.value };
}

/**
 * List available analyzers and their status.
 */
export async function listAnalyzers(
  cwd: string,
): Promise<{ id: string; categories: readonly string[]; available: boolean; reason?: string }[]> {
  const result: {
    id: string;
    categories: readonly string[];
    available: boolean;
    reason?: string;
  }[] = [];

  const context = {
    cwd,
    scope: { kind: "repository" as const, description: "analyzer check" },
    scopedFiles: [],
    artifactDirectory: cwd,
    config: DEFAULT_QA_CONFIG,
  };

  for (const analyzer of ALL_ANALYZERS) {
    try {
      const av = await analyzer.checkAvailability(context);
      result.push({
        id: analyzer.id,
        categories: analyzer.categories,
        available: av.available,
        reason: av.reason,
      });
    } catch (error) {
      result.push({
        id: analyzer.id,
        categories: analyzer.categories,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

interface QaCliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

function cliOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function cliScope(args: readonly string[]): ReviewScope {
  const kind = cliOption(args, "--scope") ?? "repository";
  const description = `CLI ${kind} review`;
  switch (kind) {
    case "diff":
      return {
        kind,
        description,
        ...(cliOption(args, "--base") ? { baseRevision: cliOption(args, "--base") } : {}),
        ...(cliOption(args, "--target") ? { targetRevision: cliOption(args, "--target") } : {}),
      };
    case "files": {
      const files = cliOption(args, "--files");
      if (!files) throw new Error("--scope files requires --files <comma-separated-paths>.");
      return {
        kind,
        description,
        files: files
          .split(",")
          .map((file) => file.trim())
          .filter(Boolean),
      };
    }
    case "module": {
      const module = cliOption(args, "--module");
      if (!module) throw new Error("--scope module requires --module <path>.");
      return { kind, description, module };
    }
    case "repository":
    case "architecture":
      return { kind, description };
    default:
      throw new Error(`Unsupported QA scope: ${kind}`);
  }
}

function cliUsage(): string {
  return [
    "Usage:",
    "  index.ts review [--scope diff|files|module|repository|architecture] [--base REF] [--target REF] [--files a,b] [--module PATH] [--cwd PATH] [--output PATH] [--trust-repository] [--allow-external-output]",
    "  index.ts validate-report <report.json>",
    "  index.ts analyzers [--cwd PATH]",
  ].join("\n");
}

/** Execute the QA command-line interface without terminating the hosting process. */
export async function runQaCli(
  args: readonly string[] = process.argv.slice(2),
  io: QaCliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  try {
    const [command] = args;
    if (command === "review") {
      const cwd = resolve(cliOption(args, "--cwd") ?? process.cwd());
      const outputDirectory = cliOption(args, "--output");
      const result = await review({
        cwd,
        scope: cliScope(args),
        config: {
          execution: { trustedRepository: args.includes("--trust-repository") },
        },
        ...(outputDirectory ? { outputDirectory } : {}),
        allowExternalOutput: args.includes("--allow-external-output"),
      });
      for (const diagnostic of result.diagnostics) io.stdout(diagnostic);
      io.stdout(`QA ${result.report.executiveSummary.overallResult}`);
      for (const artifact of result.artifacts) io.stdout(`artifact: ${artifact}`);
      return result.report.executiveSummary.overallResult === "FAIL" ? 1 : 0;
    }

    if (command === "validate-report") {
      const file = args[1];
      if (!file || file.startsWith("--")) throw new Error("validate-report requires a JSON file.");
      const parsed = JSON.parse(await readFile(resolve(file), "utf-8"));
      const result = validateReport(parsed);
      if (!result.ok) {
        io.stderr(result.summary);
        for (const violation of result.violations) {
          io.stderr(`${violation.path}: ${violation.message}`);
        }
        return 1;
      }
      io.stdout("QA report is valid.");
      return 0;
    }

    if (command === "analyzers") {
      const cwd = resolve(cliOption(args, "--cwd") ?? process.cwd());
      for (const analyzer of await listAnalyzers(cwd)) {
        io.stdout(
          `${analyzer.id}\t${analyzer.available ? "available" : "unavailable"}\t${analyzer.reason ?? analyzer.categories.join(",")}`,
        );
      }
      return 0;
    }

    io.stderr(cliUsage());
    return 2;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void runQaCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

export {
  assertQaReport,
  validateQaEvidence,
  validateQaFinding,
  validateQaReport,
} from "../contracts/contracts.ts";
export { listAnalyzerIds } from "./analyzers/registry.ts";
export { renderTextReport } from "./render-text.ts";
