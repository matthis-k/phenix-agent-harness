import type { AgentToolResult } from "../ports/agent-session-backend.ts";

const QA_REPORT_HEADING = "## QA report\n";

export function finalizeRootPresentation(result: AgentToolResult): AgentToolResult {
  return isDeterministicQaPresentation(result) ? { ...result, terminate: true } : result;
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

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
