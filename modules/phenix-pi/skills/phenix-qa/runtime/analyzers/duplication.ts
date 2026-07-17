/**
 * Phenix QA — Duplication analyzer (jscpd).
 *
 * Currently reports as unavailable by default. Provides the adapter
 * contract for future tool availability.
 */

import { makeEvidence } from "../normalize.ts";
import type {
  ProcessRunner,
  QaAnalyzer,
  QaAnalyzerAvailability,
  QaAnalyzerContext,
  QaAnalyzerResult,
} from "../types.ts";

const SUPPORTED_COMMANDS = ["jscpd"] as const;

export const DUPLICATION_ANALYZER: QaAnalyzer = {
  id: "duplication",
  categories: ["duplication", "clone-detection"],

  async checkAvailability(_context: QaAnalyzerContext): Promise<QaAnalyzerAvailability> {
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;

    for (const cmd of SUPPORTED_COMMANDS) {
      try {
        const result = await runner.exec("which", [cmd], { timeoutMs: 5_000 });
        if (result.exitCode === 0 && result.stdout.trim()) {
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
      } catch {}
    }

    return {
      available: false,
      reason: "jscpd is not installed. Run: npm install -g jscpd",
    };
  },

  async run(context: QaAnalyzerContext): Promise<QaAnalyzerResult> {
    const start = Date.now();
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;
    const diagnostics: string[] = [];
    const artifacts: string[] = [];
    const evidence: ReturnType<typeof makeEvidence>[] = [];

    for (const cmd of SUPPORTED_COMMANDS) {
      if (context.signal?.aborted) break;

      try {
        const whichResult = await runner.exec("which", [cmd], {
          timeoutMs: 5_000,
        });
        if (whichResult.exitCode !== 0) continue;

        const timeoutMs =
          context.config.timeouts.byAnalyzer?.duplication ?? context.config.timeouts.defaultMs;

        // Run jscpd with JSON reporter
        const result = await runner.exec(
          cmd,
          [context.cwd, "--reporters", "json", "--output", context.artifactDirectory, "--silent"],
          {
            cwd: context.cwd,
            timeoutMs,
            signal: context.signal,
          },
        );

        // jscpd may write JSON to output dir; try to find it
        const { writeRawArtifact } = await import("../artifacts.ts");
        const rawPath = writeRawArtifact(
          context.artifactDirectory,
          "duplication-jscpd",
          `exit: ${result.exitCode}\n\n=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}`,
          "txt",
        );
        artifacts.push(rawPath);

        if (result.timedOut) {
          return {
            analyzer: "duplication",
            status: "timed-out",
            evidence: [],
            artifacts,
            diagnostics: ["jscpd timed out."],
            durationMs: Date.now() - start,
          };
        }

        // Parse jscpd JSON output
        try {
          const { readFileSync, existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          const jscpdFile = join(context.artifactDirectory, "jscpd-report.json");
          if (existsSync(jscpdFile)) {
            const jscpdData = JSON.parse(readFileSync(jscpdFile, "utf-8"));
            const dupEvidence = normalizeJscpdOutput(jscpdData);

            if (dupEvidence.length > 0) {
              // Add summary evidence
              const duplicatesCount = jscpdData?.statistics?.total?.duplications ?? 0;
              const duplicationPercent = jscpdData?.statistics?.total?.percentage ?? 0;

              evidence.push(
                makeEvidence({
                  level: "level-1-metrics",
                  source: "duplication",
                  category: "duplication",
                  message: `Found ${duplicatesCount} duplicate blocks (${duplicationPercent}% duplication).`,
                  tool: "jscpd",
                  metric: {
                    name: "duplicationPercent",
                    value: duplicationPercent,
                    threshold: context.config.thresholds.duplicationPercent,
                    unit: "%",
                  },
                }),
              );

              evidence.push(...dupEvidence);
            }

            artifacts.push(jscpdFile);
          }
        } catch {
          diagnostics.push("Could not parse jscpd JSON output.");
        }

        diagnostics.push(`jscpd completed in ${result.durationMs}ms`);
        return {
          analyzer: "duplication",
          status: "completed",
          evidence,
          artifacts,
          diagnostics,
          durationMs: Date.now() - start,
        };
      } catch (error) {
        diagnostics.push(`${cmd}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      analyzer: "duplication",
      status: "unavailable",
      evidence: [],
      artifacts,
      diagnostics,
      durationMs: Date.now() - start,
    };
  },
};

function normalizeJscpdOutput(data: Record<string, unknown>): ReturnType<typeof makeEvidence>[] {
  const evidence: ReturnType<typeof makeEvidence>[] = [];
  const clones = (data?.clones ?? data?.duplicates ?? []) as Array<Record<string, unknown>>;

  for (const clone of clones) {
    const firstFile = (clone.firstFile as { name?: string })?.name ?? "unknown";
    const secondFile = (clone.secondFile as { name?: string })?.name ?? "unknown";
    const lines = clone.linesCount as number;
    const tokens = clone.tokensCount as number;

    evidence.push(
      makeEvidence({
        level: "level-1-metrics",
        source: "duplication",
        category: "duplicate-block",
        message: `Duplicate block: ${firstFile} ↔ ${secondFile} (${lines} lines, ${tokens} tokens)`,
        tool: "jscpd",
        locations: [{ path: firstFile }, { path: secondFile }],
        metric: {
          name: "duplicatedLines",
          value: lines ?? 0,
          unit: "lines",
        },
      }),
    );
  }

  return evidence;
}
