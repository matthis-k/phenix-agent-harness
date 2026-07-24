import path from "node:path";

import type { RunActivityChangedData, RunFactRecordedData } from "../domain/run/observability.ts";

export interface ToolObservationDescription {
  readonly activity: RunActivityChangedData;
  readonly fact: Omit<RunFactRecordedData, "reliability">;
}

export function describeToolCall(
  toolName: string,
  input: unknown,
  cwd: string,
): ToolObservationDescription {
  const values = asRecord(input);
  const file = relativePath(cwd, stringField(values, "path", "file", "filePath"));
  const targetPath = relativePath(cwd, stringField(values, "cwd", "directory", "root"));
  const pattern = compact(stringField(values, "pattern", "query", "glob"), 48);
  const command = safeCommand(stringField(values, "command", "cmd"));

  switch (toolName) {
    case "read":
      return description("exploring", "Reading file", file, "file-read", `Read ${file ?? "file"}`);
    case "grep":
      return description(
        "exploring",
        pattern ? `Searching “${pattern}”` : "Searching repository",
        file ?? targetPath,
        "search-performed",
        pattern ? `Searched for “${pattern}”` : "Searched repository",
      );
    case "find":
      return description(
        "exploring",
        "Finding files",
        pattern ?? targetPath,
        "search-performed",
        pattern ? `Found files matching ${pattern}` : "Searched for files",
      );
    case "ls":
      return description(
        "exploring",
        "Listing directory",
        file ?? targetPath,
        "search-performed",
        `Listed ${file ?? targetPath ?? "directory"}`,
      );
    case "edit":
      return description(
        "editing",
        "Editing file",
        file,
        "file-changed",
        `Edited ${file ?? "file"}`,
      );
    case "write":
      return description(
        "editing",
        "Writing file",
        file,
        "file-changed",
        `Wrote ${file ?? "file"}`,
      );
    case "bash": {
      const testing = isCheckCommand(command);
      return description(
        testing ? "testing" : "analyzing",
        testing ? "Running checks" : "Running command",
        command,
        testing ? "test-result" : "command-finished",
        testing ? `Ran checks · ${command ?? "command"}` : `Ran ${command ?? "command"}`,
      );
    }
    case "phenix_run":
      return description(
        "delegating",
        "Starting child run",
        compact(stringField(values, "definition", "definitionId", "agent"), 64),
        "child-started",
        "Started child run",
      );
    case "phenix_dispatch":
      return description(
        "delegating",
        "Starting workflow",
        compact(stringField(values, "mode", "workflow"), 64),
        "child-started",
        "Started workflow",
      );
    case "phenix_handle":
      return description(
        "waiting",
        "Inspecting child run",
        compact(stringField(values, "runId", "handle", "id"), 64),
        "decision-reported",
        "Inspected child run",
      );
    case "phenix_tasks":
      return description(
        "planning",
        "Updating task state",
        undefined,
        "decision-reported",
        "Updated tasks",
      );
    case "phenix_return":
      return description(
        "finishing",
        "Submitting result",
        undefined,
        "decision-reported",
        "Submitted result",
      );
    case "phenix_fail":
      return description(
        "finishing",
        "Reporting failure",
        undefined,
        "error-observed",
        "Reported failure",
      );
    case "phenix_progress":
      return description(
        "thinking",
        "Reporting progress",
        compact(stringField(values, "target"), 96),
        "finding-reported",
        compact(stringField(values, "message"), 96) ?? "Reported progress",
      );
    default:
      return description(
        "analyzing",
        `Running ${compact(toolName, 48) ?? "tool"}`,
        file ?? targetPath,
        "command-finished",
        `Ran ${compact(toolName, 48) ?? "tool"}`,
      );
  }
}

export function failedToolFact(
  toolName: string,
  input: unknown,
  cwd: string,
  toolCallId?: string,
): RunFactRecordedData {
  const observed = describeToolCall(toolName, input, cwd);
  return {
    kind: "error-observed",
    source: "tool",
    summary: `${observed.fact.summary} · failed`,
    ...(observed.fact.subject ? { subject: observed.fact.subject } : {}),
    provenance: toolCallId ? { toolCallId } : {},
    reliability: "observed",
  };
}

function description(
  phase: RunActivityChangedData["phase"],
  summary: string,
  target: string | undefined,
  kind: RunFactRecordedData["kind"],
  factSummary: string,
): ToolObservationDescription {
  return {
    activity: {
      phase,
      summary,
      ...(target ? { target } : {}),
      source: "derived",
    },
    fact: {
      kind,
      source: "tool",
      summary: compact(factSummary, 160) ?? summary,
      ...(target ? { subject: target } : {}),
    },
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  ...names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function relativePath(cwd: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = path.normalize(value);
  const relative = path.isAbsolute(normalized) ? path.relative(cwd, normalized) : normalized;
  return compact(relative || ".", 120);
}

function safeCommand(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const shellBodyRedacted = value.replace(
    /\b(?:ba|z|fi)?sh\s+-c\s+([\s\S]*)$/i,
    (match) => `${match.slice(0, match.indexOf("-c") + 2)} <command omitted>`,
  );
  const redacted = shellBodyRedacted
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g, "$1=<redacted>")
    .replace(
      /(\s|^)(--?(?:api[-_]?key|access[-_]?key|client[-_]?secret|credential|password|passwd|private[-_]?key|secret|token))(?:=|\s+)([^\s]+)/gi,
      "$1$2=<redacted>",
    )
    .replace(
      /((?:-H|--header)\s+["']?(?:authorization|cookie|x-api-key)\s*:\s*)[^"'\s]+/gi,
      "$1<redacted>",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1<redacted>@")
    .replace(
      /([?&](?:access_key|api_key|client_secret|credential|key|password|secret|signature|token)=)[^&\s]+/gi,
      "$1<redacted>",
    );
  return compact(redacted.replace(/\s+/g, " "), 120);
}

function isCheckCommand(command: string | undefined): boolean {
  return Boolean(
    command &&
      /(?:^|\s)(?:test|check|lint|fmt|clippy|cargo\s+test|npm\s+test|pnpm\s+test|nix\s+flake\s+check)(?:\s|$)/i.test(
        command,
      ),
  );
}

function compact(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
