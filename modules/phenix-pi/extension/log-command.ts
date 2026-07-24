import type { DiagnosticLogEntry, DiagnosticSeverity } from "../domain/diagnostics.ts";
import { isDiagnosticSeverity } from "../domain/diagnostics.ts";
import { DEFAULT_CLIPBOARD_COMMAND } from "./fact-export.ts";

export const PHENIX_LOGS_USAGE =
  "/phenix logs [--trace|--info|--warning|--warn|--error] [--json] [--copy [command]|--file <file>|--resolve <artifact-ref>]";

export type LogsCommand =
  | {
      readonly kind: "show";
      readonly minimum: DiagnosticSeverity;
      readonly json: boolean;
    }
  | {
      readonly kind: "copy";
      readonly minimum: DiagnosticSeverity;
      readonly command: string;
    }
  | {
      readonly kind: "file";
      readonly minimum: DiagnosticSeverity;
      readonly file: string;
    }
  | { readonly kind: "resolve"; readonly reference: string };

export function parseLogsCommand(raw: string): LogsCommand | undefined {
  const value = raw.trim();
  const resolve = /^(?:--resolve)\s+(.+)$/.exec(value);
  if (resolve?.[1]) return { kind: "resolve", reference: stripMatchingQuotes(resolve[1].trim()) };

  const fileIndex = value.search(/(?:^|\s)--file(?:\s|$)/);
  if (fileIndex >= 0) {
    const before = value.slice(0, fileIndex).trim();
    const fileMatch = /(?:^|\s)--file\s+([\s\S]+)$/.exec(value);
    if (!fileMatch?.[1]) return undefined;
    const minimum = parseMinimum(before);
    if (!minimum || hasUnknownOptions(before)) return undefined;
    const file = stripMatchingQuotes(fileMatch[1].trim());
    return file ? { kind: "file", minimum, file } : undefined;
  }

  const copyIndex = value.search(/(?:^|\s)--copy(?:\s|$)/);
  if (copyIndex >= 0) {
    const before = value.slice(0, copyIndex).trim();
    const after = value.slice(copyIndex).replace(/^\s*--copy\s*/, "").trim();
    const minimum = parseMinimum(before);
    if (!minimum || hasUnknownOptions(before)) return undefined;
    return {
      kind: "copy",
      minimum,
      command: stripMatchingQuotes(after) || DEFAULT_CLIPBOARD_COMMAND,
    };
  }

  const json = /(?:^|\s)--json(?:\s|$)/.test(value);
  const withoutJson = value.replace(/(?:^|\s)--json(?=\s|$)/g, " ").trim();
  const minimum = parseMinimum(withoutJson);
  if (!minimum || hasUnknownOptions(withoutJson)) return undefined;
  return { kind: "show", minimum, json };
}

export function formatDiagnosticEntries(entries: readonly DiagnosticLogEntry[]): string {
  if (entries.length === 0) return "No matching diagnostic logs.";
  return `${entries.map(formatDiagnosticEntry).join("\n")}\n`;
}

export function formatDiagnosticEntry(entry: DiagnosticLogEntry): string {
  const severity = entry.severity === "warning" ? "WARN" : entry.severity.toUpperCase();
  const identity = [
    `root=${quote(String(entry.rootRunId))}`,
    ...(entry.runId ? [`run=${quote(String(entry.runId))}`] : []),
    ...(entry.parentRunId ? [`parent=${quote(String(entry.parentRunId))}`] : []),
  ];
  const fields = flattenFields(entry.fields).map(([key, value]) => `${key}=${quote(value)}`);
  return [
    entry.timestamp,
    severity,
    entry.scope,
    ...identity,
    ...fields,
    `message=${quote(entry.message)}`,
  ].join(" ");
}

function parseMinimum(value: string): DiagnosticSeverity | undefined {
  if (!value) return "info";
  const tokens = value.split(/\s+/).filter(Boolean);
  const severities = tokens
    .filter((token) => token.startsWith("--"))
    .map((token) => normalizeSeverity(token.slice(2)))
    .filter((severity): severity is DiagnosticSeverity => severity !== undefined);
  if (severities.length > 1) return undefined;
  return severities[0] ?? "info";
}

function hasUnknownOptions(value: string): boolean {
  if (!value) return false;
  return value
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => {
      if (!token.startsWith("--")) return true;
      return normalizeSeverity(token.slice(2)) === undefined;
    });
}

function normalizeSeverity(value: string): DiagnosticSeverity | undefined {
  const normalized = value === "warn" || value === "warnin" ? "warning" : value;
  return isDiagnosticSeverity(normalized) ? normalized : undefined;
}

function flattenFields(
  fields: Readonly<Record<string, unknown>> | undefined,
): ReadonlyArray<readonly [string, string]> {
  if (!fields) return [];
  const output: Array<readonly [string, string]> = [];
  const visit = (prefix: string, value: unknown): void => {
    if (value === null || value === undefined || typeof value !== "object") {
      output.push([prefix, scalar(value)]);
      return;
    }
    if (Array.isArray(value)) {
      output.push([prefix, JSON.stringify(value)]);
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      output.push([prefix, "{}"]);
      return;
    }
    for (const [key, nested] of entries) visit(prefix ? `${prefix}.${key}` : key, nested);
  };
  for (const [key, value] of Object.entries(fields)) visit(key, value);
  return output;
}

function scalar(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  const last = value.at(-1);
  if ((first === '"' || first === "'") && last === first) return value.slice(1, -1).trim();
  return value;
}
