import { clamp, sliceViewLine, viewportRange } from "./viewport.ts";

export type TerminalViewIntent =
  | { readonly kind: "scroll"; readonly lines: number }
  | { readonly kind: "page"; readonly direction: 1 | -1 }
  | { readonly kind: "horizontal"; readonly columns: number }
  | { readonly kind: "home" }
  | { readonly kind: "end" };

export interface TerminalViewOptions {
  readonly maxLines?: number;
}

export interface TerminalViewFrame {
  readonly lines: readonly string[];
  readonly offset: number;
  readonly horizontalOffset: number;
  readonly maximumOffset: number;
  readonly followEnd: boolean;
}

export class TerminalView {
  private buffer: string[] = [];
  private offset = 0;
  private horizontalOffset = 0;
  private followEnd = true;
  private readonly maxLines: number;

  constructor(options: TerminalViewOptions = {}) {
    this.maxLines = Math.max(1, Math.floor(options.maxLines ?? 10_000));
  }

  get lineCount(): number {
    return this.buffer.length;
  }

  get lines(): readonly string[] {
    return this.buffer;
  }

  setLines(lines: readonly string[]): void {
    this.buffer = lines.slice(-this.maxLines);
    this.reconcileAfterMutation(Math.max(0, lines.length - this.buffer.length));
  }

  appendLines(lines: readonly string[]): void {
    if (lines.length === 0) return;
    this.buffer.push(...lines);
    const removed = Math.max(0, this.buffer.length - this.maxLines);
    if (removed > 0) this.buffer.splice(0, removed);
    this.reconcileAfterMutation(removed);
  }

  append(text: string): void {
    if (!text) return;
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    this.appendLines(lines);
  }

  clear(): void {
    this.buffer = [];
    this.offset = 0;
    this.horizontalOffset = 0;
    this.followEnd = true;
  }

  dispatch(intent: TerminalViewIntent, viewportHeight: number): void {
    const height = Math.max(0, Math.floor(viewportHeight));
    const maximumOffset = Math.max(0, this.buffer.length - height);
    switch (intent.kind) {
      case "scroll":
        this.setVerticalOffset(this.currentOffset(height) + intent.lines, maximumOffset);
        break;
      case "page":
        this.setVerticalOffset(
          this.currentOffset(height) + intent.direction * Math.max(1, height),
          maximumOffset,
        );
        break;
      case "horizontal":
        this.horizontalOffset = Math.max(0, this.horizontalOffset + intent.columns);
        break;
      case "home":
        this.offset = 0;
        this.followEnd = false;
        break;
      case "end":
        this.offset = maximumOffset;
        this.followEnd = true;
        break;
    }
  }

  render(width: number, height: number): TerminalViewFrame {
    const range = viewportRange(this.buffer.length, height, {
      offset: this.offset,
      followEnd: this.followEnd,
    });
    this.offset = range.offset;
    const visible = this.buffer.slice(range.offset, range.end);
    return {
      lines: Array.from({ length: Math.max(0, Math.floor(height)) }, (_, row) =>
        sliceViewLine(visible[row] ?? "", this.horizontalOffset, width),
      ),
      offset: range.offset,
      horizontalOffset: this.horizontalOffset,
      maximumOffset: range.maximumOffset,
      followEnd: this.followEnd,
    };
  }

  private currentOffset(viewportHeight: number): number {
    return viewportRange(this.buffer.length, viewportHeight, {
      offset: this.offset,
      followEnd: this.followEnd,
    }).offset;
  }

  private setVerticalOffset(offset: number, maximumOffset: number): void {
    this.offset = clamp(offset, 0, maximumOffset);
    this.followEnd = this.offset >= maximumOffset;
  }

  private reconcileAfterMutation(removedFromStart: number): void {
    if (this.followEnd) return;
    this.offset = Math.max(0, this.offset - removedFromStart);
  }
}
