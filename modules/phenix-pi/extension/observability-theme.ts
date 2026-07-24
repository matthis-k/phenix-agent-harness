import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunState } from "../domain/run/model.ts";
import type { ActivityPhase, FactKind, FactReliability } from "../domain/run/observability.ts";

export type ObservabilityTheme = ExtensionContext["ui"]["theme"];
export type ObservabilityTone =
  | "accent"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text";

const RELIABILITY_TONES: Readonly<Record<FactReliability, ObservabilityTone>> = {
  observed: "success",
  reported: "warning",
  derived: "accent",
};
const STATE_TONES: Partial<Record<RunState, ObservabilityTone>> = {
  completed: "success",
  failed: "error",
  orphaned: "error",
  waiting: "warning",
  cancelled: "muted",
};
const PHASE_TONES: Partial<Record<ActivityPhase, ObservabilityTone>> = {
  waiting: "warning",
  editing: "warning",
  finishing: "success",
  summarizing: "success",
};
const FACT_TONES: Partial<Record<FactKind, ObservabilityTone>> = {
  "error-observed": "error",
  "file-changed": "warning",
  "test-result": "success",
  "child-finished": "success",
  "finding-reported": "warning",
  "decision-reported": "warning",
  "run-started": "accent",
  "child-started": "accent",
  "workflow-transition": "accent",
};
const RUN_STATE_SUMMARY_TONES = [
  [/failed|orphaned|error|timed out/, "error"],
  [/cancelled/, "muted"],
  [/waiting/, "warning"],
  [/completed|finished/, "success"],
] as const satisfies readonly (readonly [RegExp, ObservabilityTone])[];

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
  return theme ? theme.fg("text", theme.bold(text)) : text;
}

export function state(
  theme: ObservabilityTheme | undefined,
  value: RunState,
  text: string,
): string {
  return color(theme, STATE_TONES[value] ?? "accent", text);
}

export function phase(
  theme: ObservabilityTheme | undefined,
  value: ActivityPhase,
  text: string,
): string {
  return color(theme, PHASE_TONES[value] ?? "accent", text);
}

export function reliability(
  theme: ObservabilityTheme | undefined,
  value: FactReliability,
  text: string,
): string {
  return color(theme, RELIABILITY_TONES[value], text);
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

function factTone(kind: FactKind, summary: string): ObservabilityTone {
  if (kind !== "run-state-changed") return FACT_TONES[kind] ?? "text";
  const normalized = summary.toLowerCase();
  return RUN_STATE_SUMMARY_TONES.find(([pattern]) => pattern.test(normalized))?.[1] ?? "accent";
}
