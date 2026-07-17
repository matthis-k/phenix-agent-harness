/**
 * Phenix QA — Security analyzer (Semgrep).
 *
 * Currently optional/unavailable by default. Implements the adapter contract.
 */

import { writeRawArtifact } from "../artifacts.ts";
import { makeEvidence, normalizeSarif } from "../normalize.ts";
import type {
  ProcessRunner,
  QaAnalyzer,
  QaAnalyzerAvailability,
  QaAnalyzerContext,
  QaAnalyzerResult,
} from "../types.ts";

export const SECURITY_ANALYZER: QaAnalyzer = {
  id: "security",
  categories: ["security", "vulnerability"],

  async checkAvailability(_context: QaAnalyzerContext): Promise<QaAnalyzerAvailability> {
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;

    try {
      const result = await runner.exec("semgrep", ["--version"], {
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0) {
        return {
          available: true,
          executable: "semgrep",
          version: (result.stdout + result.stderr).trim().split("\n")[0],
        };
      }
    } catch {
      // unavailable
    }

    return {
      available: false,
      reason: "Semgrep is not installed. Run: pip install semgrep",
    };
  },

  async run(context: QaAnalyzerContext): Promise<QaAnalyzerResult> {
    const start = Date.now();
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;
    const diagnostics: string[] = [];

    try {
      const whichResult = await runner.exec("which", ["semgrep"], {
        timeoutMs: 5_000,
      });
      if (whichResult.exitCode !== 0) {
        return {
          analyzer: "security",
          status: "unavailable",
          evidence: [],
          artifacts: [],
          diagnostics: ["Semgrep is not installed."],
          durationMs: Date.now() - start,
        };
      }

      const timeoutMs =
        context.config.timeouts.byAnalyzer?.["security"] ?? context.config.timeouts.defaultMs;

      // Run semgrep with SARIF output
      const result = await runner.exec(
        "semgrep",
        ["scan", "--config=auto", "--sarif", "--quiet", context.cwd],
        {
          cwd: context.cwd,
          timeoutMs,
          signal: context.signal,
        },
      );

      const rawPath = writeRawArtifact(
        context.artifactDirectory,
        "semgrep",
        `exit: ${result.exitCode}\n\n=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}`,
        "txt",
      );

      if (result.timedOut) {
        return {
          analyzer: "security",
          status: "timed-out",
          evidence: [],
          artifacts: [rawPath],
          diagnostics: ["Semgrep timed out."],
          durationMs: Date.now() - start,
        };
      }

      // Parse SARIF output
      let evidence: ReturnType<typeof makeEvidence>[] = [];
      try {
        const sarif = JSON.parse(result.stdout);
        // semgrep wraps in runs[]
        const runs = sarif?.runs ?? (Array.isArray(sarif) ? sarif : []);
        for (const run of runs) {
          const runEvidence = normalizeSarif(run, "semgrep", "security-tool", "level-7-security");
          evidence = evidence.concat(runEvidence);
        }

        if (evidence.length === 0) {
          evidence.push(
            makeEvidence({
              level: "level-7-security",
              source: "security-tool",
              category: "security-scan",
              message: "Semgrep scan completed with no findings.",
              tool: "semgrep",
            }),
          );
        }
      } catch {
        diagnostics.push("Could not parse Semgrep SARIF output.");
      }

      diagnostics.push(`Semgrep completed in ${result.durationMs}ms`);
      return {
        analyzer: "security",
        status: "completed",
        evidence,
        artifacts: [rawPath],
        diagnostics,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        analyzer: "security",
        status: "unavailable",
        evidence: [],
        artifacts: [],
        diagnostics: [`Semgrep error: ${error instanceof Error ? error.message : String(error)}`],
        durationMs: Date.now() - start,
      };
    }
  },
};
