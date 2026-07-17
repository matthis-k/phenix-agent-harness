/**
 * Phenix QA — Git history analyzer.
 *
 * Derives deterministic prioritization signals from Git history.
 * Produces evidence about churn, authors, co-change frequency, etc.
 */

import { writeRawArtifact } from "../artifacts.ts";
import { makeEvidence } from "../normalize.ts";
import type {
  ProcessRunner,
  QaAnalyzer,
  QaAnalyzerAvailability,
  QaAnalyzerContext,
  QaAnalyzerResult,
} from "../types.ts";

interface ChurnResult {
  file: string;
  changeCount: number;
  authorCount: number;
  isNew: boolean;
}

export const GIT_HISTORY_ANALYZER: QaAnalyzer = {
  id: "git-history",
  categories: ["version-control", "churn", "hotspots"],

  async checkAvailability(_context: QaAnalyzerContext): Promise<QaAnalyzerAvailability> {
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;

    try {
      // Check if we're in a git repo
      const result = await runner.exec("git", ["rev-parse", "--git-dir"], {
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0) {
        const versionResult = await runner.exec("git", ["--version"], {
          timeoutMs: 5_000,
        });
        return {
          available: true,
          executable: "git",
          version: (versionResult.stdout + versionResult.stderr).trim().split("\n")[0],
        };
      }
    } catch {
      // not a git repo
    }

    return {
      available: false,
      reason: "Not a Git repository.",
    };
  },

  async run(context: QaAnalyzerContext): Promise<QaAnalyzerResult> {
    const start = Date.now();
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;
    const diagnostics: string[] = [];
    const artifacts: string[] = [];
    const evidence: ReturnType<typeof makeEvidence>[] = [];

    // Check we're in a git repo
    try {
      const checkResult = await runner.exec("git", ["rev-parse", "--git-dir"], {
        cwd: context.cwd,
        timeoutMs: 5_000,
      });
      if (checkResult.exitCode !== 0) {
        return {
          analyzer: "git-history",
          status: "not-applicable",
          evidence: [],
          artifacts: [],
          diagnostics: ["Not a Git repository."],
          durationMs: Date.now() - start,
        };
      }
    } catch {
      return {
        analyzer: "git-history",
        status: "not-applicable",
        evidence: [],
        artifacts: [],
        diagnostics: ["Not a Git repository."],
        durationMs: Date.now() - start,
      };
    }

    const timeoutMs =
      context.config.timeouts.byAnalyzer?.["git-history"] ?? context.config.timeouts.defaultMs;

    try {
      // Get churn data (commit count per file)
      const churnResult = await runner.exec(
        "git",
        ["log", "--format=format:%H", "--name-only", "--diff-filter=AM", "-n", "500"],
        {
          cwd: context.cwd,
          timeoutMs,
          signal: context.signal,
        },
      );

      const churnPath = writeRawArtifact(
        context.artifactDirectory,
        "git-churn",
        churnResult.stdout,
        "txt",
      );
      artifacts.push(churnPath);

      // Parse churn
      const churn = parseChurn(churnResult.stdout);
      diagnostics.push(`Churn analyzed for ${churn.length} files.`);

      // Get file authors
      for (const file of churn.slice(0, 50)) {
        if (context.signal?.aborted) break;

        try {
          const authorResult = await runner.exec("git", ["shortlog", "-sne", "--", file.file], {
            cwd: context.cwd,
            timeoutMs: 10_000,
            signal: context.signal,
          });

          const authorCount = authorResult.stdout.trim().split("\n").filter(Boolean).length;

          if (file.changeCount > 20) {
            evidence.push(
              makeEvidence({
                level: "level-1-metrics",
                source: "version-control",
                category: "churn",
                message: `High churn: ${file.file} has ${file.changeCount} changes${authorCount > 3 ? ` by ${authorCount} authors` : ""}.`,
                tool: "git",
                locations: [{ path: file.file }],
                metric: { name: "changeCount", value: file.changeCount },
              }),
            );
          }

          if (file.isNew) {
            evidence.push(
              makeEvidence({
                level: "level-1-metrics",
                source: "version-control",
                category: "new-file",
                message: `New file: ${file.file}`,
                tool: "git",
                locations: [{ path: file.file }],
              }),
            );
          }
        } catch {}
      }

      // Get current branch info
      try {
        const branchResult = await runner.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: context.cwd,
          timeoutMs: 5_000,
        });
        diagnostics.push(`Current branch: ${branchResult.stdout.trim()}`);
      } catch {
        // ignore
      }
    } catch (error) {
      diagnostics.push(
        `Git history analysis error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      analyzer: "git-history",
      status: "completed",
      evidence,
      artifacts,
      diagnostics,
      durationMs: Date.now() - start,
    };
  },
};

function parseChurn(output: string): ChurnResult[] {
  const counts = new Map<string, { count: number; authors: Set<string>; seenFirst: boolean }>();
  const lines = output.split("\n");
  let _currentCommit = "";

  for (const line of lines) {
    if (!line.trim()) {
      _currentCommit = "";
      continue;
    }

    if (line.length === 40 && /^[0-9a-f]{40}$/.test(line)) {
      _currentCommit = line;
      continue;
    }

    // File name
    const file = line.trim();
    if (!file) continue;

    const existing = counts.get(file);
    if (existing) {
      existing.count++;
    } else {
      counts.set(file, { count: 1, authors: new Set(), seenFirst: true });
    }
  }

  return [...counts.entries()].map(([file, data]) => ({
    file,
    changeCount: data.count,
    authorCount: data.authors.size,
    isNew: data.count <= 2,
  }));
}
