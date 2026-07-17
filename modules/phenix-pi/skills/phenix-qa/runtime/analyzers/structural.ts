/**
 * Phenix QA — Structural rules analyzer (ast-grep).
 *
 * Runs ast-grep scan with project and repository-owned rules.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeJsonArtifact, writeRawArtifact } from "../artifacts.ts";
import { makeEvidence, normalizeSarif } from "../normalize.ts";
import type {
  ProcessRunner,
  QaAnalyzer,
  QaAnalyzerAvailability,
  QaAnalyzerContext,
  QaAnalyzerResult,
} from "../types.ts";

export const STRUCTURAL_ANALYZER: QaAnalyzer = {
  id: "structural",
  categories: ["patterns", "structural-rules"],

  async checkAvailability(_context: QaAnalyzerContext): Promise<QaAnalyzerAvailability> {
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;

    try {
      const result = await runner.exec("ast-grep", ["--version"], {
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0) {
        return {
          available: true,
          executable: "ast-grep",
          version: (result.stdout + result.stderr).trim().split("\n")[0],
        };
      }
    } catch {
      // unavailable
    }

    return {
      available: false,
      reason: "ast-grep is not installed.",
    };
  },

  async run(context: QaAnalyzerContext): Promise<QaAnalyzerResult> {
    const start = Date.now();
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;
    const diagnostics: string[] = [];
    const artifacts: string[] = [];
    const allEvidence: ReturnType<typeof makeEvidence>[] = [];

    // Collect rule directories
    const ruleDirs: string[] = [];

    // Built-in rules directory (relative to this module)
    const builtinRulesDir = join(
      import.meta.dirname ?? join(process.cwd(), "modules/phenix-pi/skills/phenix-qa"),
      "..",
      "rules",
    );
    if (existsSync(builtinRulesDir)) {
      ruleDirs.push(builtinRulesDir);
    }

    // Repository-owned rules
    for (const dir of context.config.structuralRuleDirectories) {
      const resolved = join(context.cwd, dir);
      if (existsSync(resolved)) {
        ruleDirs.push(resolved);
      }
    }

    if (ruleDirs.length === 0) {
      return {
        analyzer: "structural",
        status: "not-applicable",
        evidence: [],
        artifacts: [],
        diagnostics: ["No structural rule directories found."],
        durationMs: Date.now() - start,
      };
    }

    // Run ast-grep scan for each rule directory
    for (const ruleDir of ruleDirs) {
      if (context.signal?.aborted) break;

      try {
        const timeoutMs =
          context.config.timeouts.byAnalyzer?.structural ?? context.config.timeouts.defaultMs;

        // Use ast-grep scan with SARIF output
        const result = await runner.exec(
          "ast-grep",
          ["scan", "--config", join(ruleDir, "sgconfig.yml"), "--format", "json", context.cwd],
          {
            cwd: context.cwd,
            timeoutMs,
            signal: context.signal,
          },
        );

        // Save raw output
        const rawPath = writeRawArtifact(
          context.artifactDirectory,
          `structural-${ruleDir.replace(/[^a-zA-Z0-9]/g, "-")}`,
          `${result.stdout}\n${result.stderr}`,
          "txt",
        );
        artifacts.push(rawPath);

        if (result.timedOut) {
          diagnostics.push(`ast-grep scan timed out for ${ruleDir}`);
          continue;
        }

        if (result.exitCode !== 0 && result.exitCode !== null) {
          diagnostics.push(
            `ast-grep exited ${result.exitCode} for ${ruleDir}: ${result.stderr.slice(0, 200)}`,
          );
          // ast-grep may still produce output on non-zero exit
        }

        // Try to parse JSON output
        try {
          const parsed = JSON.parse(result.stdout);
          if (Array.isArray(parsed)) {
            // Direct array of results
            for (const item of parsed) {
              allEvidence.push(normalizeAstGrepResult(item, `ast-grep:${ruleDir}`));
            }
          } else if (parsed?.results) {
            // SARIF-like
            const sarifResults = normalizeSarif(
              parsed,
              "ast-grep",
              "structural-rule",
              "level-3-patterns",
            );
            allEvidence.push(...sarifResults);
          }

          // Save parsed JSON
          artifacts.push(
            writeJsonArtifact(
              context.artifactDirectory,
              `structural-${ruleDir.replace(/[^a-zA-Z0-9]/g, "-")}`,
              parsed,
            ),
          );
        } catch {
          diagnostics.push(`ast-grep output for ${ruleDir} was not valid JSON.`);
        }

        diagnostics.push(`ast-grep scan completed for ${ruleDir}`);
      } catch (error) {
        diagnostics.push(
          `ast-grep scan failed for ${ruleDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      analyzer: "structural",
      status: allEvidence.length > 0 ? "completed" : "completed",
      evidence: allEvidence,
      artifacts,
      diagnostics,
      durationMs: Date.now() - start,
    };
  },
};

function normalizeAstGrepResult(
  result: Record<string, unknown>,
  tool: string,
): ReturnType<typeof makeEvidence> {
  const message = (result.message as string) ?? (result.text as string) ?? "No message";
  const ruleId = (result.rule_id as string) ?? (result.ruleId as string) ?? "unknown";
  const file = (result.file as string) ?? (result.path as string) ?? "unknown";
  const line = (result.line as number) ?? (result.row as number);
  const endLine = (result.end_line as number) ?? (result.endRow as number);

  return makeEvidence({
    level: "level-3-patterns",
    source: "structural-rule",
    category: ruleId,
    message,
    tool,
    ruleId,
    locations: file !== "unknown" ? [{ path: file, startLine: line, endLine }] : [],
  });
}
