import type { RunState } from "../../domain/run/model.ts";
import type { FactKind } from "../../domain/run/observability.ts";

export type WorkspaceTextTone =
  | "accent"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text";

export interface WorkspaceTextSpan {
  readonly text: string;
  readonly tone?: WorkspaceTextTone;
  readonly strong?: boolean;
}

export interface WorkspaceRowPresentation {
  readonly spans: readonly WorkspaceTextSpan[];
  readonly active?: boolean;
  readonly muted?: boolean;
}

export function textSpan(
  text: string,
  options: Omit<WorkspaceTextSpan, "text"> = {},
): WorkspaceTextSpan {
  return { text, ...options };
}

export function runStateTone(state: RunState): WorkspaceTextTone {
  if (state === "completed") return "success";
  if (state === "failed" || state === "orphaned") return "error";
  if (state === "waiting") return "warning";
  if (state === "cancelled") return "muted";
  return "accent";
}

export function factTone(kind: FactKind, summary: string): WorkspaceTextTone {
  if (kind === "error-observed") return "error";
  if (kind === "file-changed" || kind === "finding-reported" || kind === "decision-reported") {
    return "warning";
  }
  if (kind === "test-result" || kind === "child-finished") return "success";
  if (kind === "run-started" || kind === "child-started" || kind === "workflow-transition") {
    return "accent";
  }
  if (kind !== "run-state-changed") return "text";

  const normalized = summary.toLowerCase();
  if (/failed|orphaned|error|timed out/.test(normalized)) return "error";
  if (/cancelled/.test(normalized)) return "muted";
  if (/waiting/.test(normalized)) return "warning";
  if (/completed|finished/.test(normalized)) return "success";
  return "accent";
}
