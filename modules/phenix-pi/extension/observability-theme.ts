import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  ActivityPhase,
  FactKind,
  FactReliability,
} from "../domain/run/observability.ts";
import type { RunState } from "../domain/run/model.ts";

export type ObservabilityTheme = ExtensionContext["ui"]["theme"];
export type ObservabilityTone =
  | "accent"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text";

export function color(
  theme: ObservabilityTheme | undefined,
  tone: ObservabilityTone,
  text: string,
): string {
  return theme ? theme.fg(tone, text) : text;
}

export function heading(theme: ObservabilityTheme | undefined, text: string): string {
  return theme ? theme.fg("accent", theme.bold(text)) : text;
}

export function strong(theme: ObservabilityTheme | undefined, text: string): string {
  return theme ? theme.bold(theme.fg("text", text)) : text;
}

export function state(
  theme: ObservabilityTheme | undefined,
  value: RunState,
  text: string,
): string {
  return color(theme, stateTone(value), text);
}

export function phase(
  theme: ObservabilityTheme | undefined,
  value: ActivityPhase,
  text: string,
): string {
  return color(theme, phaseTone(value), text);
}

export function reliability(
  theme: ObservabilityTheme | undefined,
  value: FactReliability,
  text: string,
): string {
  return color(
    theme,
    value === "observed" ? "success" : value === "reported" ? "warning" : "accent",
    text,
  );
}

export function fact(
  theme: ObservabilityTheme | undefined,
  kind: FactKind,
  summary: string,
  text: string,
): string {
  return color(theme, factTone(kind, summary), text);
}

export function statusLine(
  theme: ObservabilityTheme | undefined,
  profile: { readonly agent: string; readonly modelSet: string; readonly difficulty: string },
  activeCount: number,
): string {
  const profileText = `${strong(theme, profile.agent)}${color(theme, "dim", "/")}${color(
    theme,
    "accent",
    profile.modelSet,
  )}${color(theme, "dim", `/${profile.difficulty}`)}`;
  const activity =
    activeCount === 0
      ? color(theme, "success", "idle")
      : color(theme, "warning", `${activeCount} active`);
  return `${heading(theme, "phenix")}${color(theme, "dim", ":")} ${profileText} ${color(
    theme,
    "dim",
    "·",
  )} ${activity}`;
}

export function statusField(
  theme: ObservabilityTheme | undefined,
  label: string,
  value: string,
  tone: ObservabilityTone = "text",
): string {
  return `${color(theme, "dim", `${label}:`)} ${color(theme, tone, value)}`;
}

function stateTone(value: RunState): ObservabilityTone {
  if (value === "completed") return "success";
  if (value === "failed" || value === "orphaned") return "error";
  if (value === "waiting") return "warning";
  if (value === "cancelled") return "muted";
  return "accent";
}

function phaseTone(value: ActivityPhase): ObservabilityTone {
  if (value === "waiting" || value === "editing") return "warning";
  if (value === "finishing" || value === "summarizing") return "success";
  return "accent";
}

function factTone(kind: FactKind, summary: string): ObservabilityTone {
  if (kind === "error-observed") return "error";
  if (kind === "file-changed") return "warning";
  if (kind === "test-result" || kind === "child-finished") return "success";
  if (kind === "finding-reported" || kind === "decision-reported") return "warning";
  if (kind === "run-started" || kind === "child-started" || kind === "workflow-transition") {
    return "accent";
  }
  if (kind === "run-state-changed") {
    const normalized = summary.toLowerCase();
    if (/failed|orphaned|error|timed out/.test(normalized)) return "error";
    if (/cancelled/.test(normalized)) return "muted";
    if (/waiting/.test(normalized)) return "warning";
    if (/completed|finished/.test(normalized)) return "success";
    return "accent";
  }
  return "text";
}
