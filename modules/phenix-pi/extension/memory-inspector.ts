import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  matchesKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import { renderPanel } from "./components/index.ts";
import { color, type ObservabilityTheme, strong, surface } from "./observability-theme.ts";

export interface MemoryInspectorOptions {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly keybindings: KeybindingsManager;
  readonly title: string;
  readonly content: string;
  readonly onClose: () => void;
}

export class MemoryInspector implements Component, Focusable {
  focused = true;

  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly title: string;
  private readonly content: string;
  private readonly onClose: () => void;
  private offset = 0;
  private closed = false;

  constructor(options: MemoryInspectorOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.title = options.title;
    this.content = options.content;
    this.onClose = options.onClose;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.closed) return;
    const page = Math.max(1, this.viewportHeight() - 1);
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      this.keybindings.matches(data, "tui.select.confirm") ||
      data === "q"
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "up")) {
      this.offset = Math.max(0, this.offset - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "down")) {
      this.offset += 1;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.offset = Math.max(0, this.offset - page);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.offset += page;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "home")) {
      this.offset = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.offset = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(8, width - 4);
    const wrapped = wrapPlainText(this.content, innerWidth);
    const viewport = this.viewportHeight();
    const maxOffset = Math.max(0, wrapped.length - viewport);
    const offset = Math.min(this.offset, maxOffset);
    this.offset = offset;
    const visible = wrapped
      .slice(offset, offset + viewport)
      .map((line) => truncateToWidth(line, innerWidth));
    while (visible.length < viewport) visible.push("");
    const status = `${offset + 1}-${Math.min(wrapped.length, offset + viewport)}/${Math.max(1, wrapped.length)}`;
    return [
      ...renderPanel({
        lines: [
          ...visible,
          `${color(this.theme, "dim", "↑↓/PgUp/PgDn scroll · Enter/Esc/q close")} ${color(
            this.theme,
            "muted",
            status,
          )}`,
        ],
        width,
        height: viewport + 2,
        title: ` ${strong(this.theme, this.title)}`,
        paddingX: 1,
        style: {
          surface: (line) => surface(this.theme, "customMessageBg", line),
          title: (line) => surface(this.theme, "selectedBg", line),
        },
      }).lines,
    ];
  }

  private viewportHeight(): number {
    return Math.max(4, this.tui.terminal.rows - 6);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}

function wrapPlainText(value: string, width: number): string[] {
  const result: string[] = [];
  for (const sourceLine of value.replace(/\r\n/g, "\n").split("\n")) {
    if (sourceLine.length === 0) {
      result.push("");
      continue;
    }
    let remaining = sourceLine;
    while (remaining.length > width) {
      const candidate = remaining.slice(0, width + 1);
      const breakAt = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\t"));
      const take = breakAt > Math.floor(width * 0.5) ? breakAt : width;
      result.push(remaining.slice(0, take));
      remaining = remaining.slice(take).trimStart();
    }
    result.push(remaining);
  }
  return result.length > 0 ? result : [""];
}
