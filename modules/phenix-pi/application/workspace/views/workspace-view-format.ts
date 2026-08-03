import type { RunSnapshot } from "../../../domain/run/model.ts";
import type { ObjectiveState } from "../../../domain/shared.ts";
import type { WorkspaceTextTone } from "../presentation.ts";

export function definitionLabel(value: string): string {
  return value.replace(/^(?:agent|workflow|session|root)\./, "");
}

export function runStateSymbol(value: RunSnapshot["state"]): string {
  if (value === "completed") return "✓";
  if (value === "failed" || value === "orphaned") return "✗";
  if (value === "cancelled") return "−";
  if (value === "waiting") return "○";
  return "●";
}

export function runStateLabel(value: RunSnapshot["state"]): string {
  if (value === "completed") return "DONE";
  if (value === "completing") return "FINISHING";
  return value.toUpperCase();
}

export function objectiveStateSymbol(value: ObjectiveState): string {
  if (value === "done") return "✓";
  if (value === "blocked") return "!";
  if (value === "wip") return "●";
  return "○";
}

export function objectiveStateLabel(value: ObjectiveState): string {
  if (value === "done") return "DONE";
  if (value === "wip") return "ACTIVE";
  return value.toUpperCase();
}

export function objectiveStateTone(value: ObjectiveState): WorkspaceTextTone {
  if (value === "done") return "success";
  if (value === "blocked") return "error";
  if (value === "wip") return "warning";
  return "muted";
}

export function compactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 5);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function truncateWorkspaceText(value: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  if (limit === 0) return "";
  if (limit === 1) return "…";
  return `${characters.slice(0, limit - 1).join("")}…`;
}
