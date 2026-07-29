import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { ListView, renderPanel } from "../components/index.ts";
import { color, type ObservabilityTheme, strong, surface } from "../observability-theme.ts";
import {
  WorkspaceSelectDialog,
  type WorkspaceSelectDialogItem,
} from "./workspace-select-dialog.ts";

const DIALOG_OPTIONS = {
  overlay: true,
  overlayOptions: {
    width: "72%" as const,
    maxHeight: "80%" as const,
    anchor: "center" as const,
    margin: 1,
  },
};

export interface WorkspaceInputOptions {
  readonly title: string;
  readonly prompt?: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly secret?: boolean;
  readonly signal?: AbortSignal;
}

export interface WorkspaceDocumentOptions {
  readonly title: string;
  readonly lines: readonly string[];
  readonly footer?: string;
}

export interface WorkspaceChecklistItem<T> {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly value: T;
  readonly checked?: boolean;
}

export async function pickWorkspaceItems<T>(
  ctx: ExtensionContext,
  options: {
    readonly title: string;
    readonly items: readonly WorkspaceChecklistItem<T>[];
    readonly emptyMessage?: string;
  },
): Promise<readonly T[] | undefined> {
  return ctx.ui.custom<readonly T[] | undefined>(
    (tui, theme, keybindings, done) =>
      new WorkspaceChecklistDialog({
        tui,
        theme,
        keybindings,
        title: options.title,
        items: options.items,
        emptyMessage: options.emptyMessage,
        onClose: done,
      }),
    DIALOG_OPTIONS,
  );
}

export interface WorkspaceActivityController {
  readonly signal: AbortSignal;
  setTitle(title: string): void;
  setLines(lines: readonly string[]): void;
  appendLine(line: string): void;
}

export async function pickWorkspaceItem<T>(
  ctx: ExtensionContext,
  options: {
    readonly title: string;
    readonly items: readonly WorkspaceSelectDialogItem<T>[];
    readonly emptyMessage?: string;
  },
): Promise<T | undefined> {
  return ctx.ui.custom<T | undefined>(
    (tui, theme, keybindings, done) =>
      new WorkspaceSelectDialog({
        tui,
        theme,
        keybindings,
        title: options.title,
        items: options.items,
        emptyMessage: options.emptyMessage,
        onClose: done,
      }),
    DIALOG_OPTIONS,
  );
}

export async function confirmWorkspaceAction(
  ctx: ExtensionContext,
  title: string,
  message: string,
  confirmLabel = "Confirm",
): Promise<boolean> {
  const selection = await pickWorkspaceItem(ctx, {
    title,
    items: [
      { id: "confirm", label: confirmLabel, detail: message, value: true },
      { id: "cancel", label: "Cancel", value: false },
    ],
  });
  return selection === true;
}

export async function inputWorkspaceValue(
  ctx: ExtensionContext,
  options: WorkspaceInputOptions,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) =>
      new WorkspaceInputDialog({
        tui,
        theme,
        keybindings,
        ...options,
        onClose: done,
      }),
    DIALOG_OPTIONS,
  );
}

export async function showWorkspaceDocument(
  ctx: ExtensionContext,
  options: WorkspaceDocumentOptions,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new WorkspaceDocumentDialog({
        tui,
        theme,
        keybindings,
        ...options,
        onClose: done,
      }),
    DIALOG_OPTIONS,
  );
}

export async function runWorkspaceActivity(
  ctx: ExtensionContext,
  options: {
    readonly title: string;
    readonly lines?: readonly string[];
    readonly run: (controller: WorkspaceActivityController) => Promise<void>;
  },
): Promise<void> {
  let failure: unknown;
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const activity = new WorkspaceActivityDialog({
        tui,
        theme,
        keybindings,
        title: options.title,
        lines: options.lines ?? [],
        onClose: done,
      });
      queueMicrotask(() => {
        void options
          .run(activity)
          .catch((error) => {
            failure = error;
          })
          .finally(() => done());
      });
      return activity;
    },
    DIALOG_OPTIONS,
  );
  if (failure) throw failure;
}

interface WorkspaceInputDialogOptions extends WorkspaceInputOptions {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly keybindings: KeybindingsManager;
  readonly onClose: (value: string | undefined) => void;
}

class WorkspaceInputDialog implements Component, Focusable {
  focused = true;

  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly title: string;
  private readonly prompt?: string;
  private readonly placeholder?: string;
  private readonly secret: boolean;
  private readonly onClose: (value: string | undefined) => void;
  private readonly input = new Input();
  private readonly signal?: AbortSignal;
  private readonly abortHandler = (): void => this.close(undefined);
  private closed = false;

  constructor(options: WorkspaceInputDialogOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.title = options.title;
    this.prompt = options.prompt;
    this.placeholder = options.placeholder;
    this.secret = options.secret ?? false;
    this.signal = options.signal;
    this.onClose = options.onClose;
    this.input.focused = true;
    this.input.setValue(options.initialValue ?? "");
    this.input.onSubmit = (value) => this.close(value);
    this.input.onEscape = () => this.close(undefined);
    this.signal?.addEventListener("abort", this.abortHandler, { once: true });
  }

  invalidate(): void {}

  dispose(): void {
    this.signal?.removeEventListener("abort", this.abortHandler);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(undefined);
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const value = this.input.getValue();
    const display = this.secret
      ? value.length > 0
        ? `${"•".repeat(Math.max(1, Array.from(value).length))} `
        : ""
      : this.input.render(Math.max(1, width - 4))[0] ?? "";
    const empty =
      value.length === 0 && this.placeholder ? color(this.theme, "dim", this.placeholder) : "";
    const rows = [
      ...(this.prompt ? [this.prompt, ""] : []),
      `${color(this.theme, "accent", "> ")}${display || empty}`,
      "",
      color(this.theme, "dim", "Enter submit · Esc cancel"),
    ];
    return renderPanel({
      lines: rows,
      width,
      height: rows.length + 1,
      title: ` ${strong(this.theme, this.title)}`,
      paddingX: 1,
      style: {
        surface: (line) => surface(this.theme, "customMessageBg", line),
        title: (line) => surface(this.theme, "selectedBg", line),
      },
    }).lines;
  }

  private close(value: string | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abortHandler);
    this.onClose(value);
  }
}

interface WorkspaceDocumentDialogOptions extends WorkspaceDocumentOptions {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly keybindings: KeybindingsManager;
  readonly onClose: () => void;
}

class WorkspaceDocumentDialog implements Component, Focusable {
  focused = true;

  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly title: string;
  private readonly lines: readonly string[];
  private readonly footer: string;
  private readonly onClose: () => void;
  private offset = 0;
  private lastHeight = 10;
  private closed = false;

  constructor(options: WorkspaceDocumentDialogOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.title = options.title;
    this.lines = options.lines;
    this.footer = options.footer ?? "↑/↓ scroll · Esc close";
    this.onClose = options.onClose;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.closed) return;
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      this.keybindings.matches(data, "tui.select.confirm")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) this.move(-1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.move(1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.move(-this.lastHeight);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.move(this.lastHeight);
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = Math.max(0, this.lines.length - this.lastHeight);
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const viewportHeight = Math.max(3, Math.min(this.tui.terminal.rows - 8, 24));
    this.lastHeight = viewportHeight;
    const maxOffset = Math.max(0, this.lines.length - viewportHeight);
    this.offset = Math.max(0, Math.min(this.offset, maxOffset));
    const body = this.lines.slice(this.offset, this.offset + viewportHeight).map((line) =>
      truncateToWidth(line, Math.max(1, width - 4)),
    );
    while (body.length < viewportHeight) body.push("");
    const range =
      this.lines.length > viewportHeight
        ? ` ${this.offset + 1}-${Math.min(this.lines.length, this.offset + viewportHeight)}/${this.lines.length}`
        : "";
    const rows = [...body, "", color(this.theme, "dim", `${this.footer}${range}`)];
    return renderPanel({
      lines: rows,
      width,
      height: rows.length + 1,
      title: ` ${strong(this.theme, this.title)}`,
      paddingX: 1,
      style: {
        surface: (line) => surface(this.theme, "customMessageBg", line),
        title: (line) => surface(this.theme, "selectedBg", line),
      },
    }).lines;
  }

  private move(delta: number): void {
    this.offset = Math.max(0, Math.min(this.lines.length - this.lastHeight, this.offset + delta));
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}

interface WorkspaceActivityDialogOptions {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly keybindings: KeybindingsManager;
  readonly title: string;
  readonly lines: readonly string[];
  readonly onClose: () => void;
}

class WorkspaceActivityDialog implements Component, Focusable, WorkspaceActivityController {
  focused = true;

  readonly signal: AbortSignal;

  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly onClose: () => void;
  private readonly abortController = new AbortController();
  private title: string;
  private lines: string[];
  private closed = false;

  constructor(options: WorkspaceActivityDialogOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.title = options.title;
    this.lines = [...options.lines];
    this.onClose = options.onClose;
    this.signal = this.abortController.signal;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.closed || !this.keybindings.matches(data, "tui.select.cancel")) return;
    this.abortController.abort();
    this.close();
  }

  setTitle(title: string): void {
    this.title = title;
    this.tui.requestRender();
  }

  setLines(lines: readonly string[]): void {
    this.lines = [...lines];
    this.tui.requestRender();
  }

  appendLine(line: string): void {
    this.lines.push(line);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const rows = [
      ...this.lines.slice(-18).map((line) => truncateToWidth(line, Math.max(1, width - 4))),
      "",
      color(this.theme, "dim", "Esc cancel"),
    ];
    return renderPanel({
      lines: rows,
      width,
      height: rows.length + 1,
      title: ` ${strong(this.theme, this.title)}`,
      paddingX: 1,
      style: {
        surface: (line) => surface(this.theme, "customMessageBg", line),
        title: (line) => surface(this.theme, "selectedBg", line),
      },
    }).lines;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}

interface WorkspaceChecklistDialogOptions<T> {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly keybindings: KeybindingsManager;
  readonly title: string;
  readonly items: readonly WorkspaceChecklistItem<T>[];
  readonly emptyMessage?: string;
  readonly onClose: (values: readonly T[] | undefined) => void;
}

class WorkspaceChecklistDialog<T> implements Component, Focusable {
  focused = true;

  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly title: string;
  private readonly items: readonly WorkspaceChecklistItem<T>[];
  private readonly emptyMessage: string;
  private readonly onClose: (values: readonly T[] | undefined) => void;
  private readonly checked = new Set<string>();
  private readonly list: ListView<WorkspaceChecklistItem<T>>;
  private closed = false;

  constructor(options: WorkspaceChecklistDialogOptions<T>) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.title = options.title;
    this.items = options.items;
    this.emptyMessage = options.emptyMessage ?? "No items";
    this.onClose = options.onClose;
    for (const item of this.items) if (item.checked) this.checked.add(item.id);
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
    this.list.setItems(this.items);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.closed) return;
    const height = this.viewportHeight();
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.close(this.items.filter((item) => this.checked.has(item.id)).map((item) => item.value));
      return;
    }
    if (matchesKey(data, "space")) {
      const selected = this.list.selectedItem;
      if (selected) {
        if (this.checked.has(selected.id)) this.checked.delete(selected.id);
        else this.checked.add(selected.id);
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.list.dispatch({ kind: "move", direction: -1 }, height);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.list.dispatch({ kind: "move", direction: 1 }, height);
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.list.dispatch({ kind: "page", direction: -1 }, height);
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.list.dispatch({ kind: "page", direction: 1 }, height);
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = this.viewportHeight();
    const rows = [
      ...this.list.render(Math.max(0, width - 2), height, true).lines,
      "",
      color(this.theme, "dim", "Space toggle · Enter apply · Esc cancel"),
    ];
    return renderPanel({
      lines: rows,
      width,
      height: rows.length + 1,
      title: ` ${strong(this.theme, this.title)}`,
      paddingX: 1,
      style: {
        surface: (line) => surface(this.theme, "customMessageBg", line),
        title: (line) => surface(this.theme, "selectedBg", line),
      },
    }).lines;
  }

  private renderItem(item: WorkspaceChecklistItem<T>, width: number, selected: boolean): string {
    const cursor = selected ? color(this.theme, "accent", "›") : " ";
    const mark = this.checked.has(item.id)
      ? color(this.theme, "success", "●")
      : color(this.theme, "dim", "○");
    const detail = item.detail ? color(this.theme, "dim", item.detail) : "";
    const labelWidth = Math.max(1, width - visibleWidth(detail) - 6);
    const label = truncateToWidth(item.label, labelWidth);
    const padded = `${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}`;
    const row = `${cursor} ${mark} ${padded}${detail ? ` ${detail}` : ""}`;
    return selected ? surface(this.theme, "selectedBg", row) : row;
  }

  private viewportHeight(): number {
    return Math.max(3, Math.min(16, this.tui.terminal.rows - 8));
  }

  private close(values: readonly T[] | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(values);
  }
}

export function padWorkspaceColumns(left: string, right: string, width: number): string {
  const remaining = Math.max(1, width - visibleWidth(right) - 1);
  const normalizedLeft = truncateToWidth(left, remaining);
  return `${normalizedLeft}${" ".repeat(
    Math.max(1, width - visibleWidth(normalizedLeft) - visibleWidth(right)),
  )}${right}`;
}
