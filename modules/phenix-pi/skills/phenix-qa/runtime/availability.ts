/**
 * Phenix QA — Tool availability.
 *
 * Records which analyzers are installed and usable.
 */
import type { QaAnalyzerAvailability, QaAnalyzerContext } from "./types.ts";
import type { ProcessRunner } from "./types.ts";

/**
 * Check if a command is available on PATH.
 */
export async function checkCommandAvailable(
  command: string,
  runner: ProcessRunner,
): Promise<{ available: boolean; version?: string }> {
  try {
    const result = await runner.exec("which", [command], {
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return { available: false };
    }

    // Try to get version
    try {
      const versionResult = await runner.exec(command, ["--version"], {
        timeoutMs: 5_000,
      });
      const version = (versionResult.stdout + versionResult.stderr).trim();
      return { available: true, version: version.split("\n")[0] ?? version };
    } catch {
      return { available: true };
    }
  } catch {
    return { available: false };
  }
}

/**
 * Produce an availability report for all registered analyzers.
 */
export async function checkAllAvailability(
  analyzers: {
    id: string;
    checkAvailability: (
      ctx: QaAnalyzerContext,
    ) => Promise<QaAnalyzerAvailability>;
  }[],
  context: QaAnalyzerContext,
): Promise<Map<string, QaAnalyzerAvailability>> {
  const results = new Map<string, QaAnalyzerAvailability>();

  // Check sequentially to avoid overwhelming the system
  for (const analyzer of analyzers) {
    try {
      if (context.signal?.aborted) {
        results.set(analyzer.id, {
          available: false,
          reason: "cancelled",
        });
        continue;
      }
      const availability = await analyzer.checkAvailability(context);
      results.set(analyzer.id, availability);
    } catch (error) {
      results.set(analyzer.id, {
        available: false,
        reason: `check failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return results;
}

/**
 * Build an AnalysisCoverage object from analyzer results.
 */
export function buildAnalysisCoverage(params: {
  requestedAnalyzers: readonly string[];
  completedAnalyzers: readonly string[];
  unavailableAnalyzers: readonly string[];
  failedAnalyzers: readonly string[];
  coveredFiles: number;
  totalScopedFiles: number;
  coveredLanguages: readonly string[];
  uncoveredLanguages: readonly string[];
}) {
  return {
    requestedAnalyzers: [...params.requestedAnalyzers],
    completedAnalyzers: [...params.completedAnalyzers],
    unavailableAnalyzers: [...params.unavailableAnalyzers],
    failedAnalyzers: [...params.failedAnalyzers],
    coveredFiles: params.coveredFiles,
    totalScopedFiles: params.totalScopedFiles,
    coveredLanguages: [...params.coveredLanguages],
    uncoveredLanguages: [...params.uncoveredLanguages],
  };
}
