import { truncateToWidth } from "@earendil-works/pi-tui";

import type { RunSnapshot } from "../../../domain/run/model.ts";
import type { TaskNode } from "../../../domain/task/projection.ts";

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

export function taskStateSymbol(value: TaskNode["effectiveState"]): string {
  if (value === "done") return "✓";
  if (value === "failed") return "!";
  if (value === "wip") return "●";
  return "○";
}

export function compactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 5);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function truncateWorkspaceText(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), width > 1 ? "…" : "");
}
