import type {
  StructuredContentNode,
  StructuredDocument,
} from "../domain/presentation/structured-content.ts";
import type { ResultTransformStep } from "./result-presentation.ts";

interface CheckResult {
  readonly command: string;
  readonly ok: boolean;
  readonly summary: string;
}

interface QALocation {
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
}

interface QAFinding {
  readonly severity?: string;
  readonly kind?: string;
  readonly description: string;
  readonly locations: readonly QALocation[];
  readonly notes?: string;
}

interface QAReport {
  readonly summary: string;
  readonly checks: readonly CheckResult[];
  readonly findings: readonly QAFinding[];
}

const UNAVAILABLE_CHECK =
  /\b(enoent|command not found|executable not found|binary (?:was )?unavailable|could not run|couldn't run)\b/i;

export const qaReportStructuredContentStep: ResultTransformStep = {
  id: "qa-report-structured-content",
  inputKind: "contract",
  outputKind: "structured-content",
  transform(input) {
    if (input.kind !== "contract") return undefined;
    const document = qaReportDocument(input.value);
    return document ? { kind: "structured-content", document } : undefined;
  },
};

export function qaReportDocument(value: unknown): StructuredDocument | undefined {
  const report = qaReportOf(value);
  if (!report) return undefined;

  return {
    contentType: "document",
    content: "QA report",
    children: [
      section("Overview", [
        table([
          ["Field", "Value"],
          ["Gate status", gateStatus(report.checks)],
          ["Review status", reviewStatus(report.findings)],
        ]),
        paragraph(report.summary),
      ]),
      section(
        "Deterministic checks",
        report.checks.length === 0
          ? [paragraph("No deterministic checks were reported.")]
          : [
              table([
                ["Check", "Status", "Details"],
                ...report.checks.map((check) => [
                  check.command,
                  checkStatus(check).toUpperCase(),
                  check.summary,
                ]),
              ]),
            ],
      ),
      section(
        "Findings",
        report.findings.length === 0
          ? [paragraph("No review findings were reported.")]
          : [
              {
                contentType: "ordered-list",
                children: report.findings.map(findingItem),
              },
            ],
      ),
    ],
  };
}

function qaReportOf(value: unknown): QAReport | undefined {
  const report = recordOf(value);
  if (
    !report ||
    typeof report.summary !== "string" ||
    !Array.isArray(report.checks) ||
    !Array.isArray(report.findings) ||
    !report.checks.every(isCheckResult) ||
    !report.findings.every(isQaFinding)
  ) {
    return undefined;
  }
  return report as unknown as QAReport;
}

function isCheckResult(value: unknown): value is CheckResult {
  const check = recordOf(value);
  return (
    check !== undefined &&
    typeof check.command === "string" &&
    typeof check.ok === "boolean" &&
    typeof check.summary === "string"
  );
}

function isQaFinding(value: unknown): value is QAFinding {
  const finding = recordOf(value);
  return (
    finding !== undefined &&
    (finding.severity === undefined || typeof finding.severity === "string") &&
    (finding.kind === undefined || typeof finding.kind === "string") &&
    typeof finding.description === "string" &&
    Array.isArray(finding.locations) &&
    finding.locations.every(isLocation) &&
    (finding.notes === undefined || typeof finding.notes === "string")
  );
}

function isLocation(value: unknown): value is QALocation {
  const location = recordOf(value);
  return (
    location !== undefined &&
    typeof location.path === "string" &&
    typeof location.line === "number" &&
    (location.endLine === undefined || typeof location.endLine === "number")
  );
}

function findingItem(finding: QAFinding): StructuredContentNode {
  const children: StructuredContentNode[] = [];
  if (finding.locations.length > 0) {
    children.push({
      contentType: "unordered-list",
      children: finding.locations.map((location) => ({
        contentType: "list-item",
        content:
          location.endLine === undefined || location.endLine === location.line
            ? `${location.path}:${location.line}`
            : `${location.path}:${location.line}-${location.endLine}`,
      })),
    });
  }
  if (finding.notes?.trim()) children.push(paragraph(finding.notes));
  return {
    contentType: "list-item",
    content: `${finding.severity?.toUpperCase() ?? "UNSPECIFIED"} · ${finding.kind ?? "—"} — ${finding.description}`,
    ...(children.length > 0 ? { children } : {}),
  };
}

function gateStatus(checks: readonly CheckResult[]): string {
  const unavailable = checks.filter((check) => checkStatus(check) === "unavailable").length;
  const failed = checks.filter((check) => checkStatus(check) === "failed").length;
  if (unavailable > 0) return `Incomplete (${unavailable} unavailable)`;
  if (failed > 0) return `Failed (${failed})`;
  return "Passed";
}

function reviewStatus(findings: readonly QAFinding[]): string {
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const high = findings.filter((finding) => finding.severity === "high").length;
  if (critical > 0) return `Attention required (${critical} critical)`;
  if (high > 0) return `Attention required (${high} high)`;
  return findings.length > 0 ? `Findings present (${findings.length})` : "Clear";
}

function checkStatus(check: CheckResult): "passed" | "failed" | "unavailable" {
  if (check.ok) return "passed";
  return UNAVAILABLE_CHECK.test(check.summary) ? "unavailable" : "failed";
}

function section(
  content: string,
  children: readonly StructuredContentNode[],
): StructuredContentNode {
  return { contentType: "section", content, children };
}

function paragraph(content: string): StructuredContentNode {
  return { contentType: "paragraph", content };
}

function table(rows: readonly (readonly string[])[]): StructuredContentNode {
  return {
    contentType: "table",
    children: rows.map((row) => ({
      contentType: "table-row",
      children: row.map((content) => ({ contentType: "table-cell", content })),
    })),
  };
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
