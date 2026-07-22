import { isAbsolute, relative } from "node:path";

import { fileLocation, makeEvidence } from "../normalize.ts";
import type {
  ProcessRunner,
  QaAnalyzer,
  QaAnalyzerAvailability,
  QaAnalyzerContext,
  QaAnalyzerResult,
  QaEvidence,
} from "../types.ts";

const FTA_COMMAND = "fta";
const FTA_VERSION = "3.0.0";

interface FtaHalsteadMetrics {
  readonly volume: number;
  readonly difficulty: number;
  readonly effort: number;
}

interface FtaFileMetrics {
  readonly fileName: string;
  readonly cyclomaticComplexity: number;
  readonly halstead: FtaHalsteadMetrics;
  readonly lineCount: number;
  readonly ftaScore: number;
  readonly assessment: string;
}

export interface ParsedFtaMetrics {
  readonly filesAnalyzed: number;
  readonly evidence: readonly QaEvidence[];
}

export const METRICS_ANALYZER: QaAnalyzer = {
  id: "metrics",
  categories: ["metrics", "complexity"],

  async checkAvailability(_context: QaAnalyzerContext): Promise<QaAnalyzerAvailability> {
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const executable = await resolveFtaExecutable(DEFAULT_PROCESS_RUNNER);

    if (!executable) {
      return {
        available: false,
        reason: "The packaged FTA metrics analyzer is missing or not executable.",
      };
    }

    return {
      available: true,
      executable,
      version: FTA_VERSION,
    };
  },

  async run(context: QaAnalyzerContext): Promise<QaAnalyzerResult> {
    const start = Date.now();
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;
    const executable = await resolveFtaExecutable(runner);

    if (!executable) {
      return {
        analyzer: "metrics",
        status: "unavailable",
        evidence: [],
        artifacts: [],
        diagnostics: ["The packaged FTA metrics analyzer is missing or not executable."],
        durationMs: Date.now() - start,
      };
    }

    const timeoutMs =
      context.config.timeouts.byAnalyzer?.metrics ?? context.config.timeouts.defaultMs;
    const result = await runner.exec(executable, [context.cwd, "--json"], {
      cwd: context.cwd,
      timeoutMs,
      signal: context.signal,
    });

    const { writeRawArtifact } = await import("../artifacts.ts");
    const rawPath = writeRawArtifact(
      context.artifactDirectory,
      "metrics",
      `command: ${executable} ${context.cwd} --json\nexit: ${result.exitCode}\n\n=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}`,
      "txt",
    );

    if (result.timedOut) {
      return {
        analyzer: "metrics",
        status: "timed-out",
        evidence: [],
        artifacts: [rawPath],
        diagnostics: [`FTA timed out after ${timeoutMs}ms.`],
        durationMs: Date.now() - start,
      };
    }

    if (result.exitCode !== 0) {
      return {
        analyzer: "metrics",
        status: "failed",
        evidence: [],
        artifacts: [rawPath],
        diagnostics: [
          `FTA exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
        ],
        durationMs: Date.now() - start,
      };
    }

    try {
      const parsed = parseFtaJson(
        result.stdout,
        context.cwd,
        context.config.thresholds.cyclomaticComplexity,
        context.scopedFiles,
      );

      if (parsed.filesAnalyzed === 0) {
        return {
          analyzer: "metrics",
          status: "not-applicable",
          evidence: [],
          artifacts: [rawPath],
          diagnostics: [
            "FTA found no supported JavaScript or TypeScript files in the resolved scope.",
          ],
          durationMs: Date.now() - start,
        };
      }

      return {
        analyzer: "metrics",
        status: "completed",
        evidence: parsed.evidence,
        artifacts: [rawPath],
        diagnostics: [
          `FTA ${FTA_VERSION} analyzed ${parsed.filesAnalyzed} scoped JavaScript/TypeScript files in ${result.durationMs}ms.`,
        ],
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        analyzer: "metrics",
        status: "failed",
        evidence: [],
        artifacts: [rawPath],
        diagnostics: [
          `FTA returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ],
        durationMs: Date.now() - start,
      };
    }
  },
};

async function resolveFtaExecutable(runner: ProcessRunner): Promise<string | undefined> {
  try {
    const result = await runner.exec("which", [FTA_COMMAND], { timeoutMs: 5_000 });
    const executable = result.stdout.trim();
    return result.exitCode === 0 && executable.length > 0 ? executable : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the stable FTA JSON format into compact, location-aware QA evidence. */
export function parseFtaJson(
  output: string,
  cwd: string,
  cyclomaticThreshold = 20,
  scopedFiles?: readonly string[],
): ParsedFtaMetrics {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected a JSON array.");
  }

  const allowed = scopedFiles
    ? new Set(scopedFiles.map((file) => file.replaceAll("\\", "/").replace(/^\.\//, "")))
    : undefined;
  const files = parsed
    .map((value, index) => parseFtaFileMetrics(value, index))
    .filter((file) => !allowed || allowed.has(normalizeMetricPath(file.fileName, cwd)));
  if (files.length === 0) {
    return { filesAnalyzed: 0, evidence: [] };
  }

  const sorted = [...files].sort((left, right) => left.fileName.localeCompare(right.fileName));
  const maxCyclomatic = sorted.reduce((current, candidate) =>
    candidate.cyclomaticComplexity > current.cyclomaticComplexity ? candidate : current,
  );
  const maxFtaScore = sorted.reduce((current, candidate) =>
    candidate.ftaScore > current.ftaScore ? candidate : current,
  );
  const maxHalsteadVolume = sorted.reduce((current, candidate) =>
    candidate.halstead.volume > current.halstead.volume ? candidate : current,
  );
  const averageCyclomatic =
    sorted.reduce((total, file) => total + file.cyclomaticComplexity, 0) / sorted.length;
  const evidence: QaEvidence[] = [
    makeEvidence({
      level: "level-1-metrics",
      source: "metric",
      category: "complexity-summary",
      message: `FTA analyzed ${sorted.length} files; average cyclomatic complexity is ${averageCyclomatic.toFixed(2)}.`,
      tool: `FTA ${FTA_VERSION}`,
      metric: {
        name: "averageCyclomaticComplexity",
        value: averageCyclomatic,
        threshold: cyclomaticThreshold,
        unit: "paths per file",
      },
    }),
    makeEvidence({
      level: "level-1-metrics",
      source: "metric",
      category: "complexity-maximum",
      message: `Maximum cyclomatic complexity is ${maxCyclomatic.cyclomaticComplexity} in ${maxCyclomatic.fileName}.`,
      locations: [fileLocation(normalizeMetricPath(maxCyclomatic.fileName, cwd))],
      tool: `FTA ${FTA_VERSION}`,
      metric: {
        name: "maxCyclomaticComplexity",
        value: maxCyclomatic.cyclomaticComplexity,
        threshold: cyclomaticThreshold,
        unit: "paths",
      },
    }),
    makeEvidence({
      level: "level-1-metrics",
      source: "metric",
      category: "maintainability-maximum",
      message: `Worst FTA score is ${maxFtaScore.ftaScore.toFixed(2)} in ${maxFtaScore.fileName} (${maxFtaScore.assessment}); lower is better.`,
      locations: [fileLocation(normalizeMetricPath(maxFtaScore.fileName, cwd))],
      tool: `FTA ${FTA_VERSION}`,
      metric: {
        name: "maxFtaScore",
        value: maxFtaScore.ftaScore,
        unit: "score (lower is better)",
      },
    }),
    makeEvidence({
      level: "level-1-metrics",
      source: "metric",
      category: "halstead-maximum",
      message: `Maximum Halstead volume is ${maxHalsteadVolume.halstead.volume.toFixed(2)} in ${maxHalsteadVolume.fileName}.`,
      locations: [fileLocation(normalizeMetricPath(maxHalsteadVolume.fileName, cwd))],
      tool: `FTA ${FTA_VERSION}`,
      metric: {
        name: "maxHalsteadVolume",
        value: maxHalsteadVolume.halstead.volume,
        unit: "volume",
      },
    }),
  ];

  for (const file of sorted) {
    if (file.cyclomaticComplexity < cyclomaticThreshold) continue;

    evidence.push(
      makeEvidence({
        level: "level-1-metrics",
        source: "metric",
        category: "complexity-threshold",
        message: `${file.fileName} has cyclomatic complexity ${file.cyclomaticComplexity}, meeting or exceeding the review threshold ${cyclomaticThreshold}. FTA score ${file.ftaScore.toFixed(2)} (${file.assessment}); ${file.lineCount} lines; Halstead volume ${file.halstead.volume.toFixed(2)}, difficulty ${file.halstead.difficulty.toFixed(2)}, effort ${file.halstead.effort.toFixed(2)}.`,
        locations: [fileLocation(normalizeMetricPath(file.fileName, cwd))],
        tool: `FTA ${FTA_VERSION}`,
        metric: {
          name: "cyclomaticComplexity",
          value: file.cyclomaticComplexity,
          threshold: cyclomaticThreshold,
          unit: "paths",
        },
      }),
    );
  }

  return {
    filesAnalyzed: sorted.length,
    evidence,
  };
}

function parseFtaFileMetrics(value: unknown, index: number): FtaFileMetrics {
  const record = requireRecord(value, `entry ${index}`);
  const halstead = requireRecord(record.halstead, `entry ${index}.halstead`);

  return {
    fileName: requireString(record.file_name, `entry ${index}.file_name`),
    cyclomaticComplexity: requireNumber(record.cyclo, `entry ${index}.cyclo`),
    halstead: {
      volume: requireNumber(halstead.volume, `entry ${index}.halstead.volume`),
      difficulty: requireNumber(halstead.difficulty, `entry ${index}.halstead.difficulty`),
      effort: requireNumber(halstead.effort, `entry ${index}.halstead.effort`),
    },
    lineCount: requireNumber(record.line_count, `entry ${index}.line_count`),
    ftaScore: requireNumber(record.fta_score, `entry ${index}.fta_score`),
    assessment: requireString(record.assessment, `entry ${index}.assessment`),
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function normalizeMetricPath(fileName: string, cwd: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  if (!isAbsolute(normalized)) {
    return normalized.replace(/^\.\//, "");
  }

  const relativePath = relative(cwd, normalized).replaceAll("\\", "/");
  return relativePath.length > 0 ? relativePath : ".";
}
