import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runQaCli, submitModelReview } from "./index.ts";
import { renderTextReport } from "./render-text.ts";

interface QaCliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function textReportPath(jsonPath: string): string {
  return jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -5)}.txt` : `${jsonPath}.txt`;
}

/** Packaged QA CLI, including model-assisted report merging. */
export async function runPackagedQaCli(
  args: readonly string[] = process.argv.slice(2),
  io: QaCliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  if (args[0] !== "merge-review") return runQaCli(args, io);

  try {
    const reportFile = args[1];
    const contributionFile = args[2];
    if (
      !reportFile ||
      reportFile.startsWith("--") ||
      !contributionFile ||
      contributionFile.startsWith("--")
    ) {
      throw new Error(
        "merge-review requires <qa-report.json> <model-review.json> [--output merged-report.json].",
      );
    }

    const reportPath = path.resolve(reportFile);
    const contributionPath = path.resolve(contributionFile);
    const outputPath = path.resolve(option(args, "--output") ?? reportPath);
    const [report, contribution] = await Promise.all([
      readFile(reportPath, "utf8").then((value) => JSON.parse(value) as unknown),
      readFile(contributionPath, "utf8").then((value) => JSON.parse(value) as unknown),
    ]);
    const merged = submitModelReview(report, contribution);
    if (!merged.ok) {
      io.stderr(merged.summary);
      for (const violation of merged.violations) {
        io.stderr(`${violation.path}: ${violation.message}`);
      }
      return 2;
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await Promise.all([
      writeFile(outputPath, `${JSON.stringify(merged.report, null, 2)}\n`, "utf8"),
      writeFile(textReportPath(outputPath), `${renderTextReport(merged.report)}\n`, "utf8"),
    ]);
    io.stdout(`QA ${merged.report.executiveSummary.overallResult}`);
    io.stdout(`artifact: ${outputPath}`);
    io.stdout(`artifact: ${textReportPath(outputPath)}`);
    return merged.report.executiveSummary.overallResult === "FAIL" ? 1 : 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void runPackagedQaCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
