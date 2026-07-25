import type { RunSnapshot } from "../domain/run/model.ts";
import type { Outcome, RunId } from "../domain/shared.ts";

export type RunResultView = "summary" | "outcome" | "failure" | "full";

export interface ToolTransportMetrics {
  readonly sourceBytes: number;
  readonly inlineBytes: number;
  readonly omittedBytes: number;
}

export interface ProjectedCheck {
  readonly command: string;
  readonly ok: boolean;
  readonly summary: string;
}

export interface ProjectedFinding {
  readonly severity?: string;
  readonly title: string;
  readonly evidence?: string;
  readonly recommendation?: string;
}

const MAX_PROJECTED_CHECKS = 100;
const MAX_PROJECTED_FINDINGS = 50;
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
  readonly status: string;
  readonly outcome?: Outcome<unknown>;
}): unknown {
  return {
    definition: result.definition,
    selectedBy: result.selectedBy,
    runId: result.runId,
    ...(result.classifierRunId ? { classifierRunId: result.classifierRunId } : {}),
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

function projectChecks(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const rawChecks = (value as { readonly checks?: unknown }).checks;
  if (!Array.isArray(rawChecks)) return {};

  const checks = rawChecks
    .slice(0, MAX_PROJECTED_CHECKS)
    .map(projectCheck)
    .filter((check): check is ProjectedCheck => check !== undefined);
  const omittedCheckCount = Math.max(0, rawChecks.length - checks.length);

  return {
    checkCount: rawChecks.length,
    checks,
    ...(omittedCheckCount > 0 ? { omittedCheckCount } : {}),
  };
}

function projectCheck(value: unknown): ProjectedCheck | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const check = value as Readonly<Record<string, unknown>>;
  const command = boundedText(check.command, MAX_PROJECTED_TITLE_CHARS);
  const summary = boundedText(check.summary, MAX_PROJECTED_DETAIL_CHARS);
  if (!command || typeof check.ok !== "boolean" || !summary) return undefined;
  return { command, ok: check.ok, summary };
}

function projectFindings(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const rawFindings = (value as { readonly findings?: unknown }).findings;
  if (!Array.isArray(rawFindings)) return {};

  const findings = rawFindings
    .slice(0, MAX_PROJECTED_FINDINGS)
    .map(projectFinding)
    .filter((finding): finding is ProjectedFinding => finding !== undefined);
  const omittedFindingCount = Math.max(0, rawFindings.length - findings.length);

  return {
    findingCount: rawFindings.length,
    findings,
    ...(omittedFindingCount > 0 ? { omittedFindingCount } : {}),
  };
}

function projectFinding(value: unknown): ProjectedFinding | undefined {
  if (typeof value === "string") {
    const title = boundedText(value, MAX_PROJECTED_TITLE_CHARS);
    return title ? { title } : undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const finding = value as Readonly<Record<string, unknown>>;
  const title =
    boundedText(finding.title, MAX_PROJECTED_TITLE_CHARS) ??
    boundedText(finding.summary, MAX_PROJECTED_TITLE_CHARS) ??
    boundedText(finding.message, MAX_PROJECTED_TITLE_CHARS);
  if (!title) return undefined;

  const severity = boundedText(finding.severity, 32);
  const evidence = boundedText(finding.evidence, MAX_PROJECTED_DETAIL_CHARS);
  const recommendation = boundedText(finding.recommendation, MAX_PROJECTED_DETAIL_CHARS);
  return {
    ...(severity ? { severity } : {}),
    title,
    ...(evidence ? { evidence } : {}),
    ...(recommendation ? { recommendation } : {}),
  };
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
  const failedCheckCount = checks.filter((check) => !check.ok).length;
  const severityCounts = countSeverities(findings);
  const gateStatus = failedCheckCount === 0 ? "Passed" : `Failed (${failedCheckCount})`;
  const reviewStatus =
    severityCounts.high > 0
      ? `Attention required (${severityCounts.high} high)`
      : findingCount > 0
        ? `Findings present (${findingCount})`
        : "Clear";
  const sortedFindings = [...findings].sort(
    (left, right) => severityRank(right.severity) - severityRank(left.severity),
  );

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
        `| ${markdownCell(check.command)} | ${check.ok ? "PASS" : "FAIL"} | ${markdownCell(check.summary)} |`,
    ),
  );
  if (omittedCheckCount > 0) {
    lines.push("", `_${omittedCheckCount} additional checks omitted from the compact report._`);
  }

  lines.push(
    "",
    "### Finding counts",
    "",
    "| Severity | Count |",
    "|---|---:|",
    `| High | ${severityCounts.high} |`,
    `| Medium | ${severityCounts.medium} |`,
    `| Low | ${severityCounts.low} |`,
    `| Unspecified | ${severityCounts.unspecified} |`,
    "",
    "### Findings",
    "",
  );

  if (sortedFindings.length === 0) {
    lines.push("No review findings were reported.");
  } else {
    lines.push(
      "| Severity | Finding | Evidence | Recommendation |",
      "|---|---|---|---|",
      ...sortedFindings.map(
        (finding) =>
          `| ${markdownCell(finding.severity?.toUpperCase() ?? "UNSPECIFIED")} | ${markdownCell(finding.title)} | ${markdownCell(finding.evidence ?? "—")} | ${markdownCell(finding.recommendation ?? "—")} |`,
      ),
    );
  }
  if (omittedFindingCount > 0) {
    lines.push("", `_${omittedFindingCount} additional findings omitted from the compact report._`);
  }
  if (checkCount !== checks.length || findingCount !== findings.length) {
    lines.push("", `_Authoritative totals: ${checkCount} checks and ${findingCount} findings._`);
  }

  return lines.join("\n");
}

function projectedChecks(value: unknown): readonly ProjectedCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is ProjectedCheck => projectCheck(item) !== undefined);
}

function projectedFindings(value: unknown): readonly ProjectedFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(projectFinding).filter((item): item is ProjectedFinding => item !== undefined);
}

function countSeverities(findings: readonly ProjectedFinding[]): {
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly unspecified: number;
} {
  return findings.reduce(
    (counts, finding) => {
      const severity = finding.severity?.toLowerCase();
      if (severity === "high") counts.high += 1;
      else if (severity === "medium") counts.medium += 1;
      else if (severity === "low") counts.low += 1;
      else counts.unspecified += 1;
      return counts;
    },
    { high: 0, medium: 0, low: 0, unspecified: 0 },
  );
}

function severityRank(severity: string | undefined): number {
  if (severity?.toLowerCase() === "high") return 3;
  if (severity?.toLowerCase() === "medium") return 2;
  if (severity?.toLowerCase() === "low") return 1;
  return 0;
}

function markdownCell(value: string): string {
  return value.trim().replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

function markdownInline(value: string): string {
  return value.replaceAll("`", "\\`");
}

function numericCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function summaryOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const summary = (value as { readonly summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() ? summary : undefined;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : { value };
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}
