import type { AgentToolResult } from "../ports/agent-session-backend.ts";

export type ResultTransform = "auto" | "json" | "markdown";
export type ResultDisplay = "auto" | "tool" | "native";
export type ResolvedResultTransform = Exclude<ResultTransform, "auto">;
export type ResolvedResultDisplay = Exclude<ResultDisplay, "auto">;

export interface ResultPresentationRequest {
  readonly transform?: ResultTransform;
  readonly display?: ResultDisplay;
}

export interface ResultPresentationMetadata {
  readonly transform: ResolvedResultTransform;
  readonly display: ResolvedResultDisplay;
}

interface TransformedResult {
  readonly text: string;
  readonly transform: ResolvedResultTransform;
}

const QA_REPORT_HEADING = "## QA report\n";

export function presentRootResult(
  result: AgentToolResult,
  request: ResultPresentationRequest = {},
): AgentToolResult {
  const transformed = transformResult(result, request.transform ?? "auto");
  const display = resolveDisplay(request.display ?? "auto", transformed.transform);
  const details = withPresentationMetadata(result.details, {
    transform: transformed.transform,
    display,
  });
  const { terminate: _terminate, ...base } = result;
  return {
    ...base,
    text: transformed.text,
    details,
    ...(display === "native" ? { terminate: true } : {}),
  };
}

export function isDeterministicQaPresentation(result: AgentToolResult): boolean {
  if (!result.text.startsWith(QA_REPORT_HEADING)) return false;

  const details = recordOf(result.details);
  const outcome = recordOf(details?.outcome) ?? details;
  return (
    outcome?.status === "success" &&
    Array.isArray(outcome.checks) &&
    Array.isArray(outcome.findings)
  );
}

export function renderContractMarkdown(value: unknown): string {
  const lines = ["## Result"];
  const record = recordOf(value);
  if (!record) {
    lines.push("", renderScalarOrJson(value));
    return lines.join("\n");
  }

  const scalarEntries = Object.entries(record).filter(([, entry]) => isScalar(entry));
  if (scalarEntries.length > 0) {
    lines.push(
      "",
      "| Field | Value |",
      "|---|---|",
      ...scalarEntries.map(
        ([key, entry]) => `| ${markdownCell(key)} | ${markdownCell(renderScalar(entry))} |`,
      ),
    );
  }

  for (const [key, entry] of Object.entries(record)) {
    if (isScalar(entry)) continue;
    lines.push("", `### ${markdownHeading(key)}`, "", ...renderSection(entry));
  }

  if (lines.length === 1) lines.push("", "_Empty result._");
  return lines.join("\n");
}

function transformResult(result: AgentToolResult, transform: ResultTransform): TransformedResult {
  const contract = contractData(result.details);
  if (transform === "auto") {
    return isDeterministicQaPresentation(result)
      ? { text: result.text, transform: "markdown" }
      : { text: result.text, transform: "json" };
  }
  if (transform === "json") {
    return {
      text: jsonText(contract ?? result.text),
      transform,
    };
  }
  return {
    text: isDeterministicQaPresentation(result)
      ? result.text
      : renderContractMarkdown(contract ?? result.text),
    transform,
  };
}

function resolveDisplay(
  display: ResultDisplay,
  transform: ResolvedResultTransform,
): ResolvedResultDisplay {
  return display === "auto" ? (transform === "markdown" ? "native" : "tool") : display;
}

function withPresentationMetadata(
  details: unknown,
  presentation: ResultPresentationMetadata,
): unknown {
  const record = recordOf(details);
  const transport = recordOf(record?.transport);
  if (record) {
    return {
      ...record,
      transport: {
        ...(transport ?? {}),
        presentation,
      },
    };
  }
  return {
    value: details,
    transport: { presentation },
  };
}

function contractData(details: unknown): unknown {
  const record = recordOf(details);
  if (!record) return details;
  const { transport: _transport, ...contract } = record;
  return contract;
}

function renderSection(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return ["_None._"];
    if (value.every(isScalar)) {
      return value.map((entry) => `- ${markdownInline(renderScalar(entry))}`);
    }
    const rows = flatRecordRows(value);
    if (rows) return renderTable(rows);
    return fencedJson(value);
  }

  const record = recordOf(value);
  if (!record) return [renderScalarOrJson(value)];
  const entries = Object.entries(record);
  if (entries.length === 0) return ["_Empty._"];
  if (entries.every(([, entry]) => isScalar(entry))) {
    return [
      "| Field | Value |",
      "|---|---|",
      ...entries.map(
        ([key, entry]) => `| ${markdownCell(key)} | ${markdownCell(renderScalar(entry))} |`,
      ),
    ];
  }
  return fencedJson(record);
}

function flatRecordRows(value: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] | undefined {
  const rows = value.map(recordOf);
  if (rows.some((row) => !row)) return undefined;
  const records = rows as readonly Readonly<Record<string, unknown>>[];
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0 || columns.length > 10) return undefined;
  return records.every((row) => columns.every((column) => isScalar(row[column])))
    ? records
    : undefined;
}

function renderTable(rows: readonly Readonly<Record<string, unknown>>[]): string[] {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    `| ${columns.map(markdownCell).join(" | ")} |`,
    `|${columns.map(() => "---").join("|")}|`,
    ...rows.map(
      (row) =>
        `| ${columns.map((column) => markdownCell(renderScalar(row[column]))).join(" | ")} |`,
    ),
  ];
}

function fencedJson(value: unknown): string[] {
  return ["```json", jsonText(value), "```"];
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function renderScalarOrJson(value: unknown): string {
  return isScalar(value) ? markdownInline(renderScalar(value)) : fencedJson(value).join("\n");
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function renderScalar(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  return String(value);
}

function markdownHeading(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function markdownInline(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+.!|>-])/g, "\\$1").replace(/\r?\n/g, " ");
}

function markdownCell(value: string): string {
  return markdownInline(value);
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
