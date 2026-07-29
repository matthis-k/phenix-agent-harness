import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { ListView, renderPanel } from "../components/index.ts";
import { color, type ObservabilityTheme, strong, surface } from "../observability-theme.ts";

export interface WorkspaceSelectDialogItem<T> {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly searchText?: string;
  readonly current?: boolean;
  readonly value: T;
}

export interface WorkspaceSelectDialogOptions<T> {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly keybindings: KeybindingsManager;
  readonly title: string;
  readonly items: readonly WorkspaceSelectDialogItem<T>[];
  readonly emptyMessage?: string;
  readonly maxVisible?: number;
  readonly onClose: (selection: T | undefined) => void;
}

export class WorkspaceSelectDialog<T> implements Component, Focusable {
  focused = true;

  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly title: string;
  private readonly items: readonly WorkspaceSelectDialogItem<T>[];
  private readonly emptyMessage: string;
  private readonly maxVisible: number;
  private readonly onClose: (selection: T | undefined) => void;
  private readonly list: ListView<WorkspaceSelectDialogItem<T>>;
  private query = "";
  private closed = false;

  constructor(options: WorkspaceSelectDialogOptions<T>) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.title = options.title;
    this.items = options.items;
    this.emptyMessage = options.emptyMessage ?? "No matching items";
    this.maxVisible = Math.max(3, options.maxVisible ?? 12);
    this.onClose = options.onClose;
    this.list = new ListView(
      {
        id: (item) => item.id,
        render: (item, context) => this.renderItem(item, context.width, context.selected),
      },
      {
        wrapNavigation: true,
        renderEmpty: () => color(this.theme, "muted", `  ${this.emptyMessage}`),
      },
    );
    this.refreshItems();
    const current = this.items.find((item) => item.current);
    if (current) this.list.setSelectedId(current.id);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.closed) return;
    const viewportHeight = this.viewportHeight();
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.close(this.list.selectedItem?.value);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.list.dispatch({ kind: "move", direction: -1 }, viewportHeight);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.list.dispatch({ kind: "move", direction: 1 }, viewportHeight);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.list.dispatch({ kind: "page", direction: -1 }, viewportHeight);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.list.dispatch({ kind: "page", direction: 1 }, viewportHeight);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "home")) {
      this.list.dispatch({ kind: "edge", edge: "first" }, viewportHeight);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.list.dispatch({ kind: "edge", edge: "last" }, viewportHeight);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.query.length === 0) return;
      this.query = Array.from(this.query).slice(0, -1).join("");
      this.refreshItems();
      this.requestRender();
      return;
    }
    if (isPrintableInput(data)) {
      this.query += data;
      this.refreshItems();
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const listHeight = this.viewportHeight();
    const query = this.query.length > 0 ? this.query : "type to filter";
    const queryTone = this.query.length > 0 ? "text" : "dim";
    const rows = [
      `${color(this.theme, "dim", "Search:")} ${color(this.theme, queryTone, query)}`,
      color(this.theme, "dim", "─".repeat(Math.max(0, width - 2))),
      ...this.list.render(Math.max(0, width - 2), listHeight, true).lines,
    ];
    const height = rows.length + 1;
    return [
      ...renderPanel({
        lines: rows,
        width,
        height,
        title: ` ${strong(this.theme, this.title)}`,
        paddingX: 1,
        style: {
          surface: (line) => surface(this.theme, "customMessageBg", line),
          title: (line) => surface(this.theme, "selectedBg", line),
        },
      }).lines,
    ];
  }

  private renderItem(item: WorkspaceSelectDialogItem<T>, width: number, selected: boolean): string {
    const marker = selected ? color(this.theme, "accent", "›") : " ";
    const current = item.current ? color(this.theme, "success", "current") : "";
    const suffix = [item.detail, current].filter(Boolean).join(" · ");
    const suffixWidth =
      suffix.length > 0
        ? Math.min(Math.max(12, Math.floor(width * 0.42)), Math.max(0, width - 4))
        : 0;
    const labelWidth = Math.max(1, width - suffixWidth - 3);
    const label = truncateToWidth(item.label, labelWidth);
    const paddedLabel = `${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}`;
    const row =
      suffix.length > 0
        ? `${marker} ${paddedLabel} ${color(
            this.theme,
            "dim",
            truncateToWidth(suffix, suffixWidth),
          )}`
        : `${marker} ${paddedLabel}`;
    return selected ? surface(this.theme, "selectedBg", row) : row;
  }

  private refreshItems(): void {
    this.list.setItems(filterWorkspaceSelectItems(this.items, this.query));
  }

  private viewportHeight(): number {
    return Math.max(3, Math.min(this.maxVisible, this.tui.terminal.rows - 8));
  }

  private close(selection: T | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(selection);
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}

export function filterWorkspaceSelectItems<T>(
  items: readonly WorkspaceSelectDialogItem<T>[],
  query: string,
): readonly WorkspaceSelectDialogItem<T>[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return items;
  const terms = normalized.split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const haystack = [item.label, item.detail, item.searchText, item.id]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function isPrintableInput(data: string): boolean {
  const characters = Array.from(data);
  if (characters.length !== 1) return false;
  const codePoint = characters[0]?.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
}
