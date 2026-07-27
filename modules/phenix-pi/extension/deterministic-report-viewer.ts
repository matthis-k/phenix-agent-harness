import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

const REPORT_ENTRY_TYPE = "phenix:deterministic-report";
const QA_REPORT_HEADING = "## QA report\n";
const ROOT_REPORT_TOOLS = new Set(["phenix_dispatch", "phenix_handle"]);

export interface DeterministicReportEntry {
  readonly markdown: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface ToolResultProjection {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: readonly unknown[];
  readonly details?: unknown;
  readonly isError: boolean;
}

export default function deterministicReportViewer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<DeterministicReportEntry>(REPORT_ENTRY_TYPE, (entry) => {
    return new Markdown(entry.data?.markdown ?? "", 1, 0, getMarkdownTheme());
  });

  pi.on("tool_result", (event) => {
    const report = deterministicQaReportEntry(event, pi.getActiveTools());
    if (!report) return;

    pi.appendEntry(REPORT_ENTRY_TYPE, report);
    return {
      content: [{ type: "text" as const, text: "QA report rendered as Markdown." }],
    };
  });
}

export function deterministicQaReportEntry(
  event: ToolResultProjection,
  activeTools: readonly string[],
): DeterministicReportEntry | undefined {
  if (
    event.isError ||
    !activeTools.includes("phenix_dispatch") ||
    !ROOT_REPORT_TOOLS.has(event.toolName)
  ) {
    return undefined;
  }

  const markdown = textContent(event.content);
  if (!markdown?.startsWith(QA_REPORT_HEADING)) return undefined;

  const details = recordOf(event.details);
  const outcome = recordOf(details?.outcome) ?? details;
  if (
    outcome?.status !== "success" ||
    !Array.isArray(outcome.checks) ||
    !Array.isArray(outcome.findings)
  ) {
    return undefined;
  }

  return {
    markdown,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
  };
}

function textContent(content: readonly unknown[]): string | undefined {
  const text = content
    .flatMap((part) => {
      const record = recordOf(part);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
