/**
 * Phenix QA — Project-native verification analyzer.
 *
 * Discovers and runs project-native verification commands.
 */

import { writeRawArtifact } from "../artifacts.ts";
import { discoverGuidance } from "../guidance.ts";
import { makeEvidence, nextEvidenceId } from "../normalize.ts";
import type {
  ProcessRunner,
  QaAnalyzer,
  QaAnalyzerAvailability,
  QaAnalyzerContext,
  QaAnalyzerResult,
} from "../types.ts";

export const PROJECT_NATIVE_ANALYZER: QaAnalyzer = {
  id: "project-native",
  categories: ["build", "test", "lint", "format"],

  async checkAvailability(context: QaAnalyzerContext): Promise<QaAnalyzerAvailability> {
    // This analyzer depends on the project having build/test/lint commands.
    const guidance = discoverGuidance(context.cwd);

    if (guidance.buildCommands.length === 0 && guidance.testCommands.length === 0) {
      return {
        available: false,
        reason: "No project-native build or test commands discovered.",
      };
    }

    return {
      available: true,
      executable: "project-native",
      version: "discovered",
    };
  },

  async run(context: QaAnalyzerContext): Promise<QaAnalyzerResult> {
    const start = Date.now();
    const guidance = discoverGuidance(context.cwd);
    const evidence: ReturnType<typeof makeEvidence>[] = [];
    const artifacts: string[] = [];
    const diagnostics: string[] = [];

    // Dynamically choose a process runner
    const { DEFAULT_PROCESS_RUNNER } = await import("../process.ts");
    const runner: ProcessRunner = DEFAULT_PROCESS_RUNNER;

    // Run discovered commands
    const commands = [
      ...guidance.buildCommands.map((c) => ({ command: c, category: "build" })),
      ...guidance.testCommands.map((c) => ({ command: c, category: "test" })),
      ...guidance.lintCommands.map((c) => ({ command: c, category: "lint" })),
      ...guidance.formatCheckCommands.map((c) => ({ command: c, category: "format" })),
    ];

    if (commands.length === 0) {
      return {
        analyzer: "project-native",
        status: "not-applicable",
        evidence: [],
        artifacts: [],
        diagnostics: ["No project-native commands discovered."],
        durationMs: Date.now() - start,
      };
    }

    for (const { command, category } of commands) {
      if (context.signal?.aborted) {
        diagnostics.push(`Cancelled before running: ${command}`);
        break;
      }

      try {
        // Parse command: handle "npm run test", "make check", etc.
        const parts = command.split(/\s+/);
        const cmd = parts[0]!;
        const args = parts.slice(1);

        const timeoutMs = context.config.timeouts.defaultMs;
        const result = await runner.exec(cmd, args, {
          cwd: context.cwd,
          timeoutMs,
          signal: context.signal,
        });

        // Save raw output
        const safeName = command.replace(/[^a-zA-Z0-9-]/g, "-");
        const rawPath = writeRawArtifact(
          context.artifactDirectory,
          `project-native-${safeName}`,
          `exit: ${result.exitCode}\nsignal: ${result.signal}\ntimedOut: ${result.timedOut}\n\n=== STDOUT ===\n${result.stdout}\n\n=== STDERR ===\n${result.stderr}`,
          "txt",
        );
        artifacts.push(rawPath);

        // Summarize output
        const stdoutTail = result.stdout.slice(-500);
        const stderrTail = result.stderr.slice(-500);

        if (result.timedOut) {
          evidence.push(
            makeEvidence({
              level: "level-0-correctness",
              source: "test",
              category,
              message: `${command} timed out after ${timeoutMs}ms.`,
              tool: "project-native",
              rawReference: rawPath,
            }),
          );
          diagnostics.push(`${command}: timed out`);
          continue;
        }

        if (result.exitCode === 0) {
          evidence.push(
            makeEvidence({
              level: "level-0-correctness",
              source: "test",
              category,
              message: `${command} passed. Duration: ${result.durationMs}ms.`,
              tool: "project-native",
              rawReference: rawPath,
            }),
          );
          diagnostics.push(`${command}: passed (${result.durationMs}ms)`);
        } else {
          evidence.push(
            makeEvidence({
              level: "level-0-correctness",
              source: "test",
              category,
              message: `${command} failed with exit code ${result.exitCode}.${stderrTail ? `\n${stderrTail}` : ""}`,
              tool: "project-native",
              rawReference: rawPath,
            }),
          );
          diagnostics.push(`${command}: failed (exit ${result.exitCode}, ${result.durationMs}ms)`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        diagnostics.push(`${command}: error - ${msg}`);
        evidence.push(
          makeEvidence({
            level: "level-0-correctness",
            source: "test",
            category,
            message: `${command} could not be executed: ${msg}.`,
            tool: "project-native",
          }),
        );
      }
    }

    const status = evidence.some((e) => e.message.includes("failed")) ? "completed" : "completed";

    return {
      analyzer: "project-native",
      status,
      evidence,
      artifacts,
      diagnostics,
      durationMs: Date.now() - start,
    };
  },
};
