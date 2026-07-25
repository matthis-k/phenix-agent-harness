import type { RunSnapshot } from "../domain/run/model.ts";
import type { Outcome, RunId } from "../domain/shared.ts";

export type RunResultView = "summary" | "outcome" | "failure" | "full";

export interface ToolTransportMetrics {
  readonly sourceBytes: number;
  readonly inlineBytes: number;
  readonly omittedBytes: number;
}

export type ProjectedCheckStatus = "passed" | "failed" | "unavailable";

export interface ProjectedCheck {
  readonly command: string;
  readonly ok: boolean;
  readonly status: ProjectedCheckStatus;
  readonly summary: string;
}

export interface ProjectedLocation {
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
}

export interface ProjectedFinding {
  readonly severity?: string;
  readonly kind?: string;
  readonly description: string;
  readonly locations: readonly ProjectedLocation[];
  readonly notes?: string;
}

const MAX_PROJECTED_CHECKS = 100;
const MAX_PROJECTED_FINDINGS = 50;
const MAX_PROJECTED_LOCATIONS_PER_FINDING = 20;
const MAX_PROJECTED_TITLE_CHARS = 240;
const MAX_PROJECTED_DETAIL_CHARS = 500;

export function projectOutcome(
  outcome: Outcome<unknown>,
  view: Exclude<RunResultView, "full"> = "summary",
): unknown {
  if (view === "outcome") return outcome;
  if (view === "failure" && outcome.status === "failure") return outcome.failure;
  if (outcome.status === "success") {
    const summary = summaryOf(outcome.value);
    return {
      status: "success",
      ...(summary ? { summary } : {}),
      ...projectChecks(outcome.value),
      ...projectFindings(outcome.value),
      hasOutcome: true,
    };
  }
  if (outcome.status === "failure") {
    return {
      status: "failure",
      code: outcome.failure.code,
      message: outcome.failure.message,
      retryable: outcome.failure.retryable,
      ...(outcome.failure.causeRunId ? { causeRunId: outcome.failure.causeRunId } : {}),
      hasOutcome: true,
    };
  }
  return { status: "cancelled", reason: outcome.reason, hasOutcome: true };
}

export function projectRunSnapshot(
  snapshot: RunSnapshot,
  view: RunResultView = "summary",
): unknown {
  if (view === "full") return snapshot;
  if (view === "outcome") {
    return snapshot.outcome ?? { runId: snapshot.id, status: snapshot.state, hasOutcome: false };
  }
  if (view === "failure" && snapshot.outcome?.status === "failure") {
    return {
      runId: snapshot.id,
      definition: snapshot.definitionId,
      failure: snapshot.outcome.failure,
    };
  }
  return {
    runId: snapshot.id,
    ...(snapshot.parentId ? { parentId: snapshot.parentId } : {}),
    kind: snapshot.kind,
    definition: snapshot.definitionId,
    state: snapshot.state,
    ownership: snapshot.ownership,
    outputSchemaId: snapshot.outputSchemaId,
    activeChildren: snapshot.activeChildren,
    ...(snapshot.compiled.invocation.retryOf
      ? { retryOf: snapshot.compiled.invocation.retryOf }
      : {}),
    ...(snapshot.outcome ? { outcome: projectOutcome(snapshot.outcome) } : {}),
  };
}

export function projectCompletedRun(runId: RunId, outcome: Outcome<unknown>): unknown {
  return { runId, ...asRecord(projectOutcome(outcome)) };
}

export function projectRetryResult(
  runId: RunId,
  retryOf: RunId,
  outcome: Outcome<unknown>,
): unknown {
  return { runId, retryOf, ...asRecord(projectOutcome(outcome)) };
}

export function projectDispatchResult(result: {
  readonly definition: string;
  readonly selectedBy: string;
  readonly runId: RunId;
  readonly classifierRunId?: RunId;
  readonly composerRunId?: RunId;
  readonly status: string;
  readonly outcome?: Outcome<unknown>;
}): unknown {
  return {
    definition: result.definition,
    selectedBy: result.selectedBy,
    runId: result.runId,
    ...(result.classifierRunId ? { classifierRunId: result.classifierRunId } : {}),
    ...(result.composerRunId ? { composerRunId: result.composerRunId } : {}),
    status: result.status,
    ...(result.outcome ? { outcome: projectOutcome(result.outcome) } : {}),
  };
}

export function projectedToolResult(
  projected: unknown,
  source: unknown = projected,
): {
  readonly text: string;
  readonly details: unknown;
} {
  const text = renderStructuredReport(projected) ?? JSON.stringify(projected);
  const metrics = transportMetrics(source, text);
  return {
    text,
    details:
      typeof projected === "object" && projected !== null && !Array.isArray(projected)
        ? { ...projected, transport: metrics }
        : { value: projected, transport: metrics },
  };
}

export function transportMetrics(source: unknown, inline: string): ToolTransportMetrics {
  const sourceBytes = jsonBytes(source);
  const inlineBytes = Buffer.byteLength(inline, "utf8");
  return {
    sourceBytes,
    inlineBytes,
    omittedBytes: Math.max(0, sourceBytes - inlineBytes),
  };
}

function summaryOf(value: unknown): string | undefined {
  if (typeof value === "string") return truncate(value, 500);
  if (typeof value !== "object" || value === null) return undefined;
  const summary = (value as { readonly summary?: unknown }).summary;
  return typeof summary === "string" ? truncate(summary, 500) : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function projectChecks(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordOf(value);
  if (!source || !Array.isArray(source.checks)) return {};
  const checks = source.checks
    .map(projectCheck)
    .filter((check): check is ProjectedCheck => check !== undefined);
  const count = checks.length;
  const projected = checks.slice(0, MAX_PROJECTED_CHECKS);
  return {
    checks: projected,
    checkCount: count,
    omittedCheckCount: Math.max(0, count - projected.length),
  };
}

function projectCheck(value: unknown): ProjectedCheck | undefined {
  const check = recordOf(value);
  if (!check) return undefined;
  const command = boundedText(check.command, MAX_PROJECTED_TITLE_CHARS);
  const summary = boundedText(check.summary, MAX_PROJECTED_DETAIL_CHARS);
  if (!command || !summary) return undefined;
  const status = projectedCheckStatus(check);
  return { command, ok: status === "passed", status, summary };
}

function projectedCheckStatus(check: Readonly<Record<string, unknown>>): ProjectedCheckStatus {
  if (check.status === "unavailable" || check.available === false) return "unavailable";
  return check.ok === true ? "passed" : "failed";
}

function projectFindings(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordOf(value);
  if (!source || !Array.isArray(source.findings)) return {};
  const findings = source.findings
    .map(projectFinding)
    .filter((finding): finding is ProjectedFinding => finding !== undefined);
  const count = findings.length;
  const projected = findings.slice(0, MAX_PROJECTED_FINDINGS);
  return {
    findings: projected,
    findingCount: count,
    omittedFindingCount: Math.max(0, count - projected.length),
  };
}

function projectFinding(value: unknown): ProjectedFinding | undefined {
  if (typeof value === "string") {
    const description = boundedText(value, MAX_PROJECTED_TITLE_CHARS);
    return description ? { description, locations: [] } : undefined;
  }
  const finding = recordOf(value);
  if (!finding) return undefined;
  const description = boundedText(
    finding.description ?? finding.title ?? finding.summary,
    MAX_PROJECTED_TITLE_CHARS,
  );
  if (!description) return undefined;
  const severity = boundedText(finding.severity, 32)?.toLowerCase();
  const kind = boundedText(finding.kind, 80);
  const locations = projectLocations(finding.locations);
  const notes = findingNotes(finding);
  return {
    ...(severity ? { severity } : {}),
    ...(kind ? { kind } : {}),
    description,
    locations,
    ...(notes ? { notes } : {}),
  };
}

function projectLocations(value: unknown): readonly ProjectedLocation[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_PROJECTED_LOCATIONS_PER_FINDING)
    .map(projectLocation)
    .filter((location): location is ProjectedLocation => location !== undefined);
}

function projectLocation(value: unknown): ProjectedLocation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const location = value as Readonly<Record<string, unknown>>;
  const path = boundedText(location.path, MAX_PROJECTED_TITLE_CHARS);
  const line = positiveInteger(location.line);
  if (!path || line === undefined) return undefined;
  const endLine = positiveInteger(location.endLine);
  return {
    path,
    line,
    ...(endLine !== undefined && endLine >= line ? { endLine } : {}),
  };
}

function findingNotes(finding: Readonly<Record<string, unknown>>): string | undefined {
  const notes = boundedText(finding.notes, MAX_PROJECTED_DETAIL_CHARS);
  if (notes) return notes;

  const evidence = boundedText(finding.evidence, MAX_PROJECTED_DETAIL_CHARS);
  const recommendation = boundedText(finding.recommendation, MAX_PROJECTED_DETAIL_CHARS);
  if (evidence && recommendation) {
    return boundedText(
      `Evidence: ${evidence}\nRecommendation: ${recommendation}`,
      MAX_PROJECTED_DETAIL_CHARS,
    );
  }
  return evidence ?? recommendation;
}

function renderStructuredReport(projected: unknown): string | undefined {
  const envelope = recordOf(projected);
  if (!envelope) return undefined;
  const outcome = recordOf(envelope.outcome) ?? envelope;
  if (outcome.status !== "success") return undefined;

  const checks = projectedChecks(outcome.checks);
  const findings = projectedFindings(outcome.findings);
  if (!checks || !findings) return undefined;

  const checkCount = numericCount(outcome.checkCount, checks.length);
  const findingCount = numericCount(outcome.findingCount, findings.length);
  const omittedCheckCount = numericCount(outcome.omittedCheckCount, 0);
  const omittedFindingCount = numericCount(outcome.omittedFindingCount, 0);
  const unavailableCheckCount = checks.filter((check) => check.status === "unavailable").length;
  const failedCheckCount = checks.filter((check) => check.status === "failed").length;
  const severityCounts = countSeverities(findings);
  const gateStatus =
    unavailableCheckCount > 0
      ? `Incomplete (${unavailableCheckCount} unavailable)`
      : failedCheckCount > 0
        ? `Failed (${failedCheckCount})`
        : "Passed";
  const reviewStatus = reviewStatusOf(severityCounts, findingCount);

  const metadata = [
    boundedText(envelope.definition, 160)
      ? `**Definition:** \`${markdownInline(String(envelope.definition))}\``
      : undefined,
    boundedText(envelope.runId, 160)
      ? `**Run:** \`${markdownInline(String(envelope.runId))}\``
      : undefined,
    `**Gate status:** ${gateStatus}`,
    `**Review status:** ${reviewStatus}`,
  ].filter((line): line is string => line !== undefined);

  const summary = boundedText(outcome.summary, 2_000);
  const lines = ["## QA report", "", ...metadata];
  if (summary) lines.push("", summary);

  lines.push(
    "",
    "### Deterministic checks",
    "",
    "| Check | Status | Details |",
    "|---|---|---|",
    ...checks.map(
      (check) =>
        `| \`${markdownInline(check.command)}\` | ${checkLabel(check.status)} | ${markdownCell(check.summary)} |`,
    ),
  );
  if (checks.length === 0) lines.push("| — | — | No checks reported | ");
  if (omittedCheckCount > 0) {
    lines.push("", `_${omittedCheckCount} of ${checkCount} checks omitted by projection bounds._`);
  }

  lines.push(
    "",
    "### Finding counts",
    "",
    "| Severity | Count |",
    "|---|---:|",
    ...severityRows(severityCounts),
    "",
    "### Findings",
    "",
    "| # | Severity | Kind | Description | Locations | Notes |",
    "|---:|---|---|---|---|---|",
    ...findings.map(
      (finding, index) =>
        `| ${index + 1} | ${markdownCell(finding.severity ?? "unspecified")} | ${markdownCell(
          finding.kind ?? "—",
        )} | ${markdownCell(finding.description)} | ${markdownCell(
          renderLocations(finding.locations),
        )} | ${markdownCell(finding.notes ?? "—")} |`,
    ),
  );
  if (findings.length === 0) lines.push("| — | — | — | No findings | — | — |");
  if (omittedFindingCount > 0) {
    lines.push(
      "",
      `_${omittedFindingCount} of ${findingCount} findings omitted by projection bounds._`,
    );
  }
  return lines.join("\n");
}

function projectedChecks(value: unknown): readonly ProjectedCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(projectCheck).filter((check): check is ProjectedCheck => check !== undefined);
}

function projectedFindings(value: unknown): readonly ProjectedFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(projectFinding)
    .filter((finding): finding is ProjectedFinding => finding !== undefined);
}

function countSeverities(findings: readonly ProjectedFinding[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    const severity = finding.severity ?? "unspecified";
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  return counts;
}

function severityRows(counts: Readonly<Record<string, number>>): readonly string[] {
  const order = ["critical", "high", "medium", "low", "info", "unspecified"];
  const rows = order
    .filter((severity) => (counts[severity] ?? 0) > 0)
    .map((severity) => `| ${markdownCell(severity)} | ${counts[severity]} |`);
  return rows.length > 0 ? rows : ["| — | 0 |"]; 
}

function reviewStatusOf(counts: Readonly<Record<string, number>>, total: number): string {
  if ((counts.critical ?? 0) > 0) return `Blocked (${counts.critical} critical)`;
  if ((counts.high ?? 0) > 0) return `Attention required (${counts.high} high)`;
  return total > 0 ? `Findings present (${total})` : "Clear";
}

function checkLabel(status: ProjectedCheckStatus): string {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  return "UNAVAILABLE";
}

function renderLocations(locations: readonly ProjectedLocation[]): string {
  if (locations.length === 0) return "—";
  return locations
    .map((location) => {
      const line = location.endLine
        ? `${location.line}-${location.endLine}`
        : String(location.line);
      return `${location.path}:${line}`;
    })
    .join(", ");
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function markdownInline(value: string): string {
  return value.replaceAll("`", "\\`");
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return recordOf(value) ?? { value };
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return truncate(trimmed, max);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function numericCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}
