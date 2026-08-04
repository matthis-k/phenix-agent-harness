import { randomUUID } from "node:crypto";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";

import type { HeadlessExtensionUiResponse } from "./protocol.ts";

type ExtensionTheme = ExtensionUIContext["theme"];

export type HeadlessExtensionUiRequest =
  | { readonly kind: "select"; readonly title: string; readonly options: readonly string[] }
  | { readonly kind: "confirm"; readonly title: string; readonly message: string }
  | { readonly kind: "input"; readonly title: string; readonly placeholder?: string }
  | { readonly kind: "editor"; readonly title: string; readonly prefill?: string };

export type HeadlessExtensionUiEvent =
  | {
      readonly type: "extension_ui.requested";
      readonly dialogId: string;
      readonly request: HeadlessExtensionUiRequest;
    }
  | { readonly type: "extension_ui.cancelled"; readonly dialogId: string }
  | {
      readonly type: "notification";
      readonly level: "info" | "warning" | "error";
      readonly message: string;
    }
  | { readonly type: "status.changed"; readonly key: string; readonly text?: string }
  | {
      readonly type: "widget.changed";
      readonly key: string;
      readonly lines?: readonly string[];
      readonly placement?: "aboveEditor" | "belowEditor";
    }
  | { readonly type: "working.message"; readonly message?: string }
  | { readonly type: "working.visibility"; readonly visible: boolean }
  | {
      readonly type: "working.indicator";
      readonly frames?: readonly string[];
      readonly intervalMs?: number;
    }
  | { readonly type: "thinking.hidden_label"; readonly label?: string }
  | { readonly type: "terminal.title"; readonly title: string }
  | { readonly type: "editor.replace"; readonly text: string }
  | { readonly type: "editor.paste"; readonly text: string }
  | { readonly type: "tools.expanded"; readonly expanded: boolean }
  | { readonly type: "extension_ui.unsupported"; readonly feature: string };

export interface HeadlessThemeAccess {
  readonly current: ExtensionTheme;
  list(): { readonly name: string; readonly path: string | undefined }[];
  get(name: string): ExtensionTheme | undefined;
  set(theme: string | ExtensionTheme): { readonly success: boolean; readonly error?: string };
}

interface PendingDialog {
  readonly resolve: (response: HeadlessExtensionUiResponse) => void;
}

export class HeadlessExtensionUi {
  readonly #publish: (event: HeadlessExtensionUiEvent) => void;
  readonly #themes: HeadlessThemeAccess;
  readonly #createId: () => string;
  readonly #pending = new Map<string, PendingDialog>();
  readonly context: ExtensionUIContext;
  #editorText = "";
  #toolsExpanded = false;

  constructor(input: {
    readonly publish: (event: HeadlessExtensionUiEvent) => void;
    readonly themes: HeadlessThemeAccess;
    readonly createId?: () => string;
  }) {
    this.#publish = input.publish;
    this.#themes = input.themes;
    this.#createId = input.createId ?? randomUUID;

    const setWidget = ((
      key: string,
      content: unknown,
      options?: ExtensionWidgetOptions,
    ): void => {
      if (content === undefined || isStringArray(content)) {
        this.#publish({
          type: "widget.changed",
          key,
          ...(content === undefined ? {} : { lines: content }),
          ...(options?.placement === undefined ? {} : { placement: options.placement }),
        });
        return;
      }
      this.unsupported(`component widget ${key}`);
    }) as ExtensionUIContext["setWidget"];

    this.context = {
      select: (title, options, opts) =>
        this.requestDialog(
          { kind: "select", title, options },
          opts,
          (response) => (response.kind === "selected" ? response.value : undefined),
        ),
      confirm: (title, message, opts) =>
        this.requestDialog(
          { kind: "confirm", title, message },
          opts,
          (response) => (response.kind === "confirmed" ? response.value : false),
        ),
      input: (title, placeholder, opts) =>
        this.requestDialog(
          {
            kind: "input",
            title,
            ...(placeholder ? { placeholder } : {}),
          },
          opts,
          (response) => (response.kind === "text" ? response.value : undefined),
        ),
      notify: (message, type = "info") => {
        this.#publish({ type: "notification", level: type, message });
      },
      onTerminalInput: () => {
        this.unsupported("raw terminal input listener");
        return () => undefined;
      },
      setStatus: (key, text) => {
        this.#publish({
          type: "status.changed",
          key,
          ...(text === undefined ? {} : { text }),
        });
      },
      setWorkingMessage: (message) => {
        this.#publish({
          type: "working.message",
          ...(message === undefined ? {} : { message }),
        });
      },
      setWorkingVisible: (visible) => {
        this.#publish({ type: "working.visibility", visible });
      },
      setWorkingIndicator: (options) => {
        this.#publish({
          type: "working.indicator",
          ...(options?.frames === undefined ? {} : { frames: options.frames }),
          ...(options?.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
        });
      },
      setHiddenThinkingLabel: (label) => {
        this.#publish({
          type: "thinking.hidden_label",
          ...(label === undefined ? {} : { label }),
        });
      },
      setWidget,
      setFooter: () => this.unsupported("custom footer component"),
      setHeader: () => this.unsupported("custom header component"),
      setTitle: (title) => this.#publish({ type: "terminal.title", title }),
      custom: async () => {
        this.unsupported("custom focused component");
        throw new Error(`Custom Pi components are unavailable in the headless runtime`);
      },
      pasteToEditor: (text) => {
        this.#editorText += text;
        this.#publish({ type: "editor.paste", text });
      },
      setEditorText: (text) => {
        this.#editorText = text;
        this.#publish({ type: "editor.replace", text });
      },
      getEditorText: () => this.#editorText,
      editor: (title, prefill) =>
        this.requestDialog(
          {
            kind: "editor",
            title,
            ...(prefill === undefined ? {} : { prefill }),
          },
          undefined,
          (response) => (response.kind === "text" ? response.value : undefined),
        ),
      addAutocompleteProvider: () => this.unsupported("Pi autocomplete provider"),
      setEditorComponent: () => this.unsupported("custom Pi editor component"),
      getEditorComponent: () => undefined,
      get theme() {
        return input.themes.current;
      },
      getAllThemes: () => this.#themes.list(),
      getTheme: (name) => this.#themes.get(name),
      setTheme: (theme) => this.#themes.set(theme),
      getToolsExpanded: () => this.#toolsExpanded,
      setToolsExpanded: (expanded) => {
        this.#toolsExpanded = expanded;
        this.#publish({ type: "tools.expanded", expanded });
      },
    };
  }

  respond(dialogId: string, response: HeadlessExtensionUiResponse): void {
    const pending = this.#pending.get(dialogId);
    if (!pending) throw new Error(`Unknown extension UI dialog: ${dialogId}`);
    pending.resolve(response);
  }

  dispose(): void {
    for (const pending of this.#pending.values()) {
      pending.resolve({ kind: "cancelled" });
    }
    this.#pending.clear();
  }

  private requestDialog<T>(
    request: HeadlessExtensionUiRequest,
    options: ExtensionUIDialogOptions | undefined,
    parse: (response: HeadlessExtensionUiResponse) => T,
  ): Promise<T> {
    if (options?.signal?.aborted) {
      return Promise.resolve(parse({ kind: "cancelled" }));
    }
    const dialogId = this.#createId();
    return new Promise<T>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (response: HeadlessExtensionUiResponse): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(parse(response));
      };
      const onAbort = (): void => {
        this.#publish({ type: "extension_ui.cancelled", dialogId });
        finish({ kind: "cancelled" });
      };
      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(dialogId);
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.timeout !== undefined) {
        timeout = setTimeout(onAbort, options.timeout);
      }
      this.#pending.set(dialogId, { resolve: finish });
      this.#publish({ type: "extension_ui.requested", dialogId, request });
    });
  }

  private unsupported(feature: string): void {
    this.#publish({ type: "extension_ui.unsupported", feature });
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
