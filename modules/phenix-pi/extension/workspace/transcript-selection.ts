import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

export interface TranscriptPoint {
  readonly row: number;
  readonly column: number;
}

export interface TranscriptSelection {
  readonly anchor: TranscriptPoint;
  readonly focus: TranscriptPoint;
}

export interface TranscriptSelectionRange {
  readonly start: TranscriptPoint;
  readonly end: TranscriptPoint;
}

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");

export function stripTranscriptAnsi(line: string): string {
  return line.replace(ANSI_PATTERN, "");
}

export function normalizeTranscriptSelection(
  selection: TranscriptSelection,
): TranscriptSelectionRange {
  return comparePoints(selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

export function clampTranscriptPoint(
  point: TranscriptPoint,
  lines: readonly string[],
): TranscriptPoint {
  if (lines.length === 0) return { row: 0, column: 0 };
  const row = clamp(Math.floor(point.row), 0, lines.length - 1);
  return {
    row,
    column: clamp(Math.floor(point.column), 0, visibleWidth(lines[row] ?? "")),
  };
}

export function transcriptSelectionColumns(
  selection: TranscriptSelection | undefined,
  row: number,
  line: string,
): readonly [number, number] | undefined {
  if (!selection) return undefined;
  const { start, end } = normalizeTranscriptSelection(selection);
  if (comparePoints(start, end) === 0 || row < start.row || row > end.row) return undefined;
  const width = visibleWidth(line);
  const from = row === start.row ? clamp(start.column, 0, width) : 0;
  const to = row === end.row ? clamp(end.column, 0, width) : width;
  return to > from ? [from, to] : undefined;
}

export function selectedTranscriptText(
  lines: readonly string[],
  selection: TranscriptSelection | undefined,
): string | undefined {
  if (!selection || lines.length === 0) return undefined;
  const clamped = {
    anchor: clampTranscriptPoint(selection.anchor, lines),
    focus: clampTranscriptPoint(selection.focus, lines),
  };
  const { start, end } = normalizeTranscriptSelection(clamped);
  if (comparePoints(start, end) === 0) return undefined;

  const selected: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const line = lines[row] ?? "";
    const width = visibleWidth(line);
    const from = row === start.row ? start.column : 0;
    const to = row === end.row ? end.column : width;
    selected.push(sliceByColumn(line, from, Math.max(0, to - from), true));
  }
  return selected.join("\n");
}

function comparePoints(left: TranscriptPoint, right: TranscriptPoint): number {
  return left.row - right.row || left.column - right.column;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
