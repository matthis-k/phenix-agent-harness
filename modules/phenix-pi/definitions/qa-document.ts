import type { StructuredContentNode, StructuredDocument } from "../domain/presentation/structured-content.ts";
import type { CheckResult, QAAnalysis, QAFinding } from "./schemas.ts";

const UNAVAILABLE_CHECK =
  /\b(enoent|command not found|executable not found|binary (?:was )?unavailable|could not run|couldn't run)\b/i;

export function qaDocument(input: {
  readonly analysis: QAAnalysis;
  readonly checks: readonly CheckResult[];
}): StructuredDocument {
  const findings = input.analysis.findings;
  return {
    contentType: "document",
    content: "QA report",
    children: [
      section("Overview", [
        table([
          ["Field", "Value"],
          ["Gate status", gateStatus(input.checks)],
          ["Review status", reviewStatus(findings)],
        ]),
        paragraph(input.analysis.summary),
      ]),
      section(
        "Deterministic checks",
        input.checks.length === 0
          ? [paragraph("No deterministic checks were reported.")]
          : [
              table([
                ["Check", "Status", "Details"],
                ...input.checks.map((check) => [
                  check.command,
                  checkStatus(check).toUpperCase(),
                  check.summary,
                ]),
              ]),
            ],
      ),
      section(
        "Findings",
        findings.length === 0
          ? [paragraph("No review findings were reported.")]
          : [
              {
                contentType: "ordered-list",
                children: findings.map(findingItem),
              },
            ],
      ),
    ],
  };
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
  if (finding.notes.trim()) children.push(paragraph(finding.notes));
  return {
    contentType: "list-item",
    content: `${finding.severity.toUpperCase()} · ${finding.kind} — ${finding.description}`,
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
