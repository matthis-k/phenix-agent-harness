/**
 * Phenix QA — Multi-language code metrics analyzer.
 *
 * Currently reports as unavailable by default. Supports codehawk-cli
 * when installed. Extensible to other metric tools.
 */

import { makeEvidence } from "../normalize.ts";
import type {
  ProcessRunner,
  QaAnalyzer,
  QaAnalyzerAvailability,
  QaAnalyzerContext,
  QaAnalyzerResult,
} from "../types.ts";

const SUPPORTED_COMMANDS = ["codehawk-cli", "codehawk"] as const;

export const METRICS_ANALYZER: QaAnalyzer = {
  id: "metrics",
  categories: ["metrics", "complexity"],

  async checkAvailability(context: QaAnalyzerContext): Promise<QaAnalyzerAvailability> {
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;

    for (const cmd of SUPPORTED_COMMANDS) {
      try {
        // Check if the command is available via npx or direct
        const result = await runner.exec("which", [cmd], { timeoutMs: 5_000 });
        if (result.exitCode === 0 && result.stdout.trim()) {
          // Get version
          try {
            const versionResult = await runner.exec(cmd, ["--version"], {
              timeoutMs: 5_000,
            });
            return {
              available: true,
              executable: result.stdout.trim(),
              version: (versionResult.stdout + versionResult.stderr).trim().split("\n")[0],
            };
          } catch {
            return { available: true, executable: result.stdout.trim() };
          }
        }

        // Also try npx
        const npxResult = await runner.exec("npx", [cmd, "--version"], {
          timeoutMs: 15_000,
        });
        if (npxResult.exitCode === 0) {
          return {
            available: true,
            executable: `npx ${cmd}`,
            version: (npxResult.stdout + npxResult.stderr).trim().split("\n")[0],
          };
        }
      } catch {}
    }

    return {
      available: false,
      reason: "No supported metrics analyzer found. Install codehawk-cli for metrics support.",
    };
  },

  async run(context: QaAnalyzerContext): Promise<QaAnalyzerResult> {
    const start = Date.now();
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;
    const diagnostics: string[] = [];

    // Try each supported command
    for (const cmd of SUPPORTED_COMMANDS) {
      if (context.signal?.aborted) break;

      try {
        // Try direct execution first
        let execCmd = cmd;
        let execArgs: string[] = [context.cwd];

        const whichResult = await runner.exec("which", [cmd], {
          timeoutMs: 5_000,
        });

        if (whichResult.exitCode !== 0) {
          // Try via npx
          execCmd = "npx";
          execArgs = [cmd, context.cwd];
        }

        const timeoutMs =
          context.config.timeouts.byAnalyzer?.["metrics"] ?? context.config.timeouts.defaultMs;

        const result = await runner.exec(execCmd, execArgs, {
          cwd: context.cwd,
          timeoutMs,
          signal: context.signal,
        });

        // Save raw output
        const { writeRawArtifact } = await import("../artifacts.ts");
        const rawPath = writeRawArtifact(
          context.artifactDirectory,
          "metrics",
          `command: ${execCmd} ${execArgs.join(" ")}\nexit: ${result.exitCode}\n\n=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}`,
          "txt",
        );

        if (result.timedOut) {
          return {
            analyzer: "metrics",
            status: "timed-out",
            evidence: [],
            artifacts: [rawPath],
            diagnostics: [`${cmd} timed out.`],
            durationMs: Date.now() - start,
          };
        }

        if (result.exitCode !== 0) {
          diagnostics.push(`${cmd} exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`);
          return {
            analyzer: "metrics",
            status: "failed",
            evidence: [],
            artifacts: [rawPath],
            diagnostics,
            durationMs: Date.now() - start,
          };
        }

        // Parse metrics from output
        // codehawk-cli produces a text summary; we try to extract what we can
        const evidence = parseMetricsOutput(result.stdout, cmd);
        diagnostics.push(`${cmd} completed in ${result.durationMs}ms`);

        return {
          analyzer: "metrics",
          status: "completed",
          evidence,
          artifacts: [rawPath],
          diagnostics,
          durationMs: Date.now() - start,
        };
      } catch (error) {
        diagnostics.push(`${cmd}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      analyzer: "metrics",
      status: "unavailable",
      evidence: [],
      artifacts: [],
      diagnostics,
      durationMs: Date.now() - start,
    };
  },
};

/**
 * Parse metrics output from codehawk-cli or similar tools.
 */
function parseMetricsOutput(output: string, _tool: string): ReturnType<typeof makeEvidence>[] {
  const evidence: ReturnType<typeof makeEvidence>[] = [];

  // Try to find common metric patterns in the output
  const patterns = [
    { regex: /cyclomatic complexity[:\s]+(\d+(?:\.\d+)?)/i, name: "cyclomaticComplexity" },
    { regex: /cognitive complexity[:\s]+(\d+(?:\.\d+)?)/i, name: "cognitiveComplexity" },
    { regex: /maintainability[:\s]+(\d+(?:\.\d+)?)/i, name: "maintainabilityIndex" },
    { regex: /halstead volume[:\s]+(\d+(?:\.\d+)?)/i, name: "halsteadVolume" },
    { regex: /lines of code[:\s]+(\d+)/i, name: "physicalLines" },
    { regex: /logical lines[:\s]+(\d+)/i, name: "logicalLines" },
    { regex: /ABC score[:\s]+(\d+(?:\.\d+)?)/i, name: "abcScore" },
    { regex: /parameter count[:\s]+(\d+)/i, name: "parameterCount" },
  ];

  for (const { regex, name } of patterns) {
    const match = output.match(regex);
    if (match?.[1]) {
      const value = parseFloat(match[1]);
      evidence.push(
        makeEvidence({
          level: "level-1-metrics",
          source: "metric",
          category: "complexity",
          message: `${name}: ${value}`,
          tool: "metrics-analyzer",
          metric: {
            name,
            value,
            unit: name === "maintainabilityIndex" ? "index" : "count",
          },
        }),
      );
    }
  }

  return evidence;
}
