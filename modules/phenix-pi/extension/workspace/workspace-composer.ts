import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { SessionProfile } from "../../domain/run/model.ts";
import { color, type ObservabilityTheme, surface } from "../observability-theme.ts";
import { stripTranscriptAnsi } from "./transcript-selection.ts";

const MINIMUM_EDITOR_ROWS = 2;

export interface WorkspaceComposerInput {
  readonly lines: readonly string[];
  readonly width: number;
  readonly active: boolean;
  readonly sidebarVisible: boolean;
  readonly profile: SessionProfile;
  readonly theme: ObservabilityTheme;
}

export function renderWorkspaceComposer(input: WorkspaceComposerInput): readonly string[] {
  const width = Math.max(1, input.width);
  const innerWidth = Math.max(0, width - 3);
  const body = editorBody(input.lines);
  const rows = [
    "",
    ...Array.from({ length: Math.max(MINIMUM_EDITOR_ROWS, body.length) }, (_, index) =>
      fitLine(body[index] ?? "", innerWidth),
    ),
    "",
  ];
  const profile = `${input.profile.agent} · ${input.profile.modelSet} · ${input.profile.difficulty}`;
  const help = input.sidebarVisible
    ? "tab sidebar · pgup/pgdn transcript · ctrl+o native"
    : "ctrl+b sidebar · pgup/pgdn transcript · ctrl+o native";
  rows.push(joinColumns(profile, help, innerWidth));

  const tone = input.active ? "userMessageBg" : "customMessageBg";
  const rail = color(input.theme, input.active ? "accent" : "muted", input.active ? "┃" : "│");
  return rows.map((line) => surface(input.theme, tone, fitLine(`${rail} ${line}`, width)));
}

export function editorBody(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;
  if (start < end && isEditorRule(lines[start] ?? "")) start += 1;
  if (start < end && isEditorRule(lines[end - 1] ?? "")) end -= 1;
  const body = lines.slice(start, end);
  return body.length > 0 ? body : [""];
}

function isEditorRule(line: string): boolean {
  const plain = stripTranscriptAnsi(line).trim();
  return plain.length > 0 && /^[─━═┄┅┈┉╌╍┌┐└┘╭╮╰╯\s-]+$/u.test(plain);
}

function joinColumns(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "");
  const leftLimit = Math.max(0, width - rightWidth - 1);
  const clippedLeft = truncateToWidth(left, leftLimit, leftLimit > 1 ? "…" : "");
  const gap = Math.max(1, width - visibleWidth(clippedLeft) - rightWidth);
  return fitLine(`${clippedLeft}${" ".repeat(gap)}${right}`, width);
}

function fitLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
