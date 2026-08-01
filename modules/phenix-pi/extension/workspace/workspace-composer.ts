import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { color, type ObservabilityTheme, surface } from "../observability-theme.ts";
import { stripTranscriptAnsi } from "./transcript-selection.ts";

const MINIMUM_EDITOR_ROWS = 1;
const TRANSCRIPT_GAP_ROWS = 1;
const STATUS_GAP_ROWS = 2;

export interface WorkspaceComposerInput {
  readonly lines: readonly string[];
  readonly width: number;
  readonly active: boolean;
  readonly theme: ObservabilityTheme;
}

export function renderWorkspaceComposer(input: WorkspaceComposerInput): readonly string[] {
  const width = Math.max(1, input.width);
  const innerWidth = Math.max(0, width - 3);
  const body = editorBody(input.lines);
  const rows = [
    ...blankRows(TRANSCRIPT_GAP_ROWS),
    ...Array.from({ length: Math.max(MINIMUM_EDITOR_ROWS, body.length) }, (_, index) =>
      fitLine(body[index] ?? "", innerWidth),
    ),
    ...blankRows(STATUS_GAP_ROWS),
  ];

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

function blankRows(count: number): readonly string[] {
  return Array.from({ length: count }, () => "");
}

function isEditorRule(line: string): boolean {
  const plain = stripTranscriptAnsi(line).trim();
  return plain.length > 0 && /^[─━═┄┅┈┉╌╍┌┐└┘╭╮╰╯\s-]+$/u.test(plain);
}

function fitLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
