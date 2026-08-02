import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { Rect } from "../../domain/workspace/geometry.ts";
import type { ObservabilityTheme } from "../observability-theme.ts";
import { surface } from "../observability-theme.ts";
import {
  clampTranscriptPoint,
  selectedTranscriptText,
  stripTranscriptAnsi,
  type TranscriptPoint,
  type TranscriptSelection,
  transcriptSelectionColumns,
} from "./transcript-selection.ts";

export interface TranscriptSelectionFrame {
  readonly bounds: Rect;
  readonly offset: number;
  readonly lines: readonly string[];
}

export interface TranscriptMousePoint {
  readonly x: number;
  readonly y: number;
}

export class TranscriptSelectionSurface {
  private selectionValue: TranscriptSelection | undefined;
  private frameValue: TranscriptSelectionFrame | undefined;
  private draggingValue = false;

  get dragging(): boolean {
    return this.draggingValue;
  }

  get selection(): TranscriptSelection | undefined {
    return this.selectionValue;
  }

  setFrame(frame: TranscriptSelectionFrame): void {
    this.frameValue = frame;
    if (!this.selectionValue) return;
    this.selectionValue = {
      anchor: clampTranscriptPoint(this.selectionValue.anchor, frame.lines),
      focus: clampTranscriptPoint(this.selectionValue.focus, frame.lines),
    };
  }

  begin(point: TranscriptMousePoint): boolean {
    const transcriptPoint = this.pointFromMouse(point);
    if (!transcriptPoint) return false;
    this.selectionValue = { anchor: transcriptPoint, focus: transcriptPoint };
    this.draggingValue = true;
    return true;
  }

  update(point: TranscriptMousePoint): boolean {
    if (!this.draggingValue || !this.selectionValue) return false;
    const transcriptPoint = this.pointFromMouse(point, true);
    if (!transcriptPoint) return false;
    this.selectionValue = { ...this.selectionValue, focus: transcriptPoint };
    return true;
  }

  end(point: TranscriptMousePoint): boolean {
    if (!this.draggingValue) return false;
    this.update(point);
    this.draggingValue = false;
    return true;
  }

  clear(): void {
    this.selectionValue = undefined;
    this.draggingValue = false;
  }

  selectedText(): string | undefined {
    return selectedTranscriptText(this.frameValue?.lines ?? [], this.selectionValue);
  }

  async copy(): Promise<boolean> {
    const selected = this.selectedText();
    const fullTranscript = this.frameValue?.lines.join("\n").trimEnd();
    const text = selected || fullTranscript;
    if (!text) return false;
    await copyToClipboard(text);
    return true;
  }

  renderLine(line: string, absoluteRow: number, width: number, theme: ObservabilityTheme): string {
    const plain = stripTranscriptAnsi(line);
    const columns = transcriptSelectionColumns(this.selectionValue, absoluteRow, plain);
    if (!columns) return line;
    const [from, to] = columns;
    const prefix = sliceByColumn(plain, 0, from, true);
    const selected = sliceByColumn(plain, from, to - from, true);
    const suffix = sliceByColumn(plain, to, Math.max(0, visibleWidth(plain) - to), true);
    return truncateToWidth(
      `${prefix}${surface(theme, "selectedBg", selected)}${suffix}`,
      Math.max(0, width),
      "",
    );
  }

  private pointFromMouse(
    point: TranscriptMousePoint,
    clampOutside = false,
  ): TranscriptPoint | undefined {
    const frame = this.frameValue;
    if (!frame || frame.lines.length === 0 || frame.bounds.height <= 1) return undefined;
    const terminalX = point.x - 1;
    const terminalY = point.y - 1;
    const minimumX = frame.bounds.x;
    const maximumX = frame.bounds.x + Math.max(0, frame.bounds.width - 1);
    const minimumY = frame.bounds.y + 1;
    const maximumY = frame.bounds.y + Math.max(1, frame.bounds.height - 1);
    if (
      !clampOutside &&
      (terminalX < minimumX || terminalX > maximumX || terminalY < minimumY || terminalY > maximumY)
    ) {
      return undefined;
    }
    const localRow = clamp(terminalY, minimumY, maximumY) - minimumY;
    const row = clamp(frame.offset + localRow, 0, frame.lines.length - 1);
    return {
      row,
      column: clamp(terminalX, minimumX, maximumX) - minimumX,
    } satisfies TranscriptPoint;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
