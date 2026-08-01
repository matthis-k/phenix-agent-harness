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
type SurfaceTone = "selectedBg" | "customMessageBg" | "userMessageBg";

interface BackgroundFrame {
  readonly prefix: string;
  readonly suffix: string;
}

const BACKGROUND_MARKER = "\u0000";
const SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, "g");
const BACKGROUND_FRAMES = new WeakMap<object, Map<SurfaceTone, BackgroundFrame>>();

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

export function surface(
  theme: ObservabilityTheme | undefined,
  tone: SurfaceTone,
  text: string,
): string {
  if (!theme) return text;
  const frame = backgroundFrame(theme, tone);
  if (!frame) return theme.bg(tone, text);
  return `${frame.prefix}${restoreBackground(text, frame.prefix)}${frame.suffix}`;
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
  _activeCount: number,
): string {
  const profileText = `${strong(theme, profile.agent)}${color(theme, "dim", "/")}${color(
    theme,
    "accent",
    profile.modelSet,
  )}${color(theme, "dim", `/${profile.difficulty}`)}`;
  return `${heading(theme, "phenix")}${color(theme, "dim", ":")} ${profileText}`;
}

export function statusField(
  theme: ObservabilityTheme | undefined,
  label: string,
  value: string,
  tone: ObservabilityTone = "text",
): string {
  return `${color(theme, "dim", `${label}:`)} ${color(theme, tone, value)}`;
}

function backgroundFrame(
  theme: ObservabilityTheme,
  tone: SurfaceTone,
): BackgroundFrame | undefined {
  const key = theme as object;
  let frames = BACKGROUND_FRAMES.get(key);
  if (!frames) {
    frames = new Map();
    BACKGROUND_FRAMES.set(key, frames);
  }
  const cached = frames.get(tone);
  if (cached) return cached;

  const wrapped = theme.bg(tone, BACKGROUND_MARKER);
  const marker = wrapped.indexOf(BACKGROUND_MARKER);
  if (marker < 0) return undefined;
  const frame = {
    prefix: wrapped.slice(0, marker),
    suffix: wrapped.slice(marker + BACKGROUND_MARKER.length),
  };
  frames.set(tone, frame);
  return frame;
}

function restoreBackground(text: string, prefix: string): string {
  if (!prefix) return text;
  return text.replace(SGR_PATTERN, (sequence, parameters: string) => {
    const values = parameters === "" ? [0] : parameters.split(";").map(Number);
    return values.includes(0) || values.includes(49) ? `${sequence}${prefix}` : sequence;
  });
}

function factTone(kind: FactKind, summary: string): ObservabilityTone {
  if (kind !== "run-state-changed") return FACT_TONES[kind] ?? "text";
  const normalized = summary.toLowerCase();
  return RUN_STATE_SUMMARY_TONES.find(([pattern]) => pattern.test(normalized))?.[1] ?? "accent";
}
