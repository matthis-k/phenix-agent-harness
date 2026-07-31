import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type {
  UserFormAnswer,
  UserFormCompletion,
  UserFormQuestion,
  UserFormRequest,
} from "../../domain/user-form/model.ts";
import { renderPanel } from "../components/index.ts";
import { color, type ObservabilityTheme, strong, surface } from "../observability-theme.ts";

interface DraftAnswer {
  readonly value: string;
  readonly cursor: number;
  readonly suggestionValue?: string;
}

export interface UserFormDialogOptions {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly keybindings: KeybindingsManager;
  readonly request: UserFormRequest;
  readonly onClose: (completion: UserFormCompletion) => void;
}

export class UserFormDraft {
  readonly request: UserFormRequest;
  private readonly answers: DraftAnswer[];
  activeQuestion = 0;
  suggestionOpen = false;
  suggestionIndex = 0;
  validationMessage: string | undefined;

  constructor(request: UserFormRequest) {
    this.request = request;
    this.answers = request.form.questions.map((question) => {
      const value = question.initialAnswer ?? "";
      return { value, cursor: Array.from(value).length };
    });
  }

  answer(index = this.activeQuestion): DraftAnswer {
    return this.answers[index] ?? { value: "", cursor: 0 };
  }

  moveQuestion(direction: -1 | 1): void {
    const count = this.request.form.questions.length;
    this.activeQuestion = (this.activeQuestion + direction + count) % count;
    this.suggestionOpen = false;
    this.suggestionIndex = 0;
    this.validationMessage = undefined;
  }

  insert(text: string): void {
    if (!text) return;
    const current = this.answer();
    const characters = Array.from(current.value);
    characters.splice(current.cursor, 0, ...Array.from(text));
    this.replaceActive({ value: characters.join(""), cursor: current.cursor + Array.from(text).length });
  }

  backspace(): void {
    const current = this.answer();
    if (current.cursor === 0) return;
    const characters = Array.from(current.value);
    characters.splice(current.cursor - 1, 1);
    this.replaceActive({ value: characters.join(""), cursor: current.cursor - 1 });
  }

  deleteForward(): void {
    const current = this.answer();
    const characters = Array.from(current.value);
    if (current.cursor >= characters.length) return;
    characters.splice(current.cursor, 1);
    this.replaceActive({ value: characters.join(""), cursor: current.cursor });
  }

  moveCursor(direction: -1 | 1): void {
    const current = this.answer();
    const length = Array.from(current.value).length;
    this.replaceActive({
      ...current,
      cursor: Math.max(0, Math.min(length, current.cursor + direction)),
    });
  }

  moveCursorTo(edge: "start" | "end"): void {
    const current = this.answer();
    this.replaceActive({
      ...current,
      cursor: edge === "start" ? 0 : Array.from(current.value).length,
    });
  }

  openSuggestions(): void {
    if (this.activeSuggestions().length === 0) return;
    this.suggestionOpen = true;
    this.suggestionIndex = 0;
  }

  moveSuggestion(direction: -1 | 1): void {
    const suggestions = this.activeSuggestions();
    if (suggestions.length === 0) return;
    this.suggestionIndex =
      (this.suggestionIndex + direction + suggestions.length) % suggestions.length;
  }

  applySuggestion(index = this.suggestionIndex): void {
    const suggestion = this.activeSuggestions()[index];
    if (!suggestion) return;
    this.replaceActive({
      value: suggestion.value,
      cursor: Array.from(suggestion.value).length,
      suggestionValue: suggestion.value,
    });
    this.suggestionOpen = false;
    this.validationMessage = undefined;
  }

  completion(): UserFormCompletion | undefined {
    const missing = this.request.form.questions.findIndex(
      (question, index) => question.required && !this.answer(index).value.trim(),
    );
    if (missing >= 0) {
      this.activeQuestion = missing;
      this.suggestionOpen = false;
      this.validationMessage = `Question ${missing + 1} requires an answer.`;
      return undefined;
    }
    const answers: UserFormAnswer[] = this.request.form.questions.map((question, index) => {
      const answer = this.answer(index);
      return {
        questionId: question.id,
        answer: answer.value,
        ...(answer.suggestionValue === answer.value
          ? { suggestionValue: answer.suggestionValue }
          : {}),
      };
    });
    return { status: "submitted", answers };
  }

  private activeSuggestions() {
    return this.request.form.questions[this.activeQuestion]?.suggestions ?? [];
  }

  private replaceActive(next: DraftAnswer): void {
    this.answers[this.activeQuestion] = {
      value: next.value,
      cursor: next.cursor,
      ...(next.suggestionValue !== undefined ? { suggestionValue: next.suggestionValue } : {}),
    };
    if (next.suggestionValue !== next.value) {
      this.answers[this.activeQuestion] = { value: next.value, cursor: next.cursor };
    }
    this.validationMessage = undefined;
  }
}

export class UserFormDialog implements Component, Focusable {
  focused = true;

  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly onClose: (completion: UserFormCompletion) => void;
  private readonly draft: UserFormDraft;
  private closed = false;
  private viewportOffset = 0;

  constructor(options: UserFormDialogOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.onClose = options.onClose;
    this.draft = new UserFormDraft(options.request);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.draft.suggestionOpen) {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.draft.suggestionOpen = false;
        this.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.up")) {
        this.draft.moveSuggestion(-1);
        this.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.down")) {
        this.draft.moveSuggestion(1);
        this.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.draft.applySuggestion();
        this.requestRender();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close({ status: "cancelled", reason: "user" });
      return;
    }
    if (matchesKey(data, "ctrl+space")) {
      this.draft.openSuggestions();
      this.requestRender();
      return;
    }
    const directSuggestion = suggestionShortcut(data);
    if (directSuggestion !== undefined) {
      this.draft.applySuggestion(directSuggestion);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+enter")) {
      this.submit();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.submit")) {
      if (this.draft.activeQuestion === this.draft.request.form.questions.length - 1) {
        this.submit();
      } else {
        this.draft.moveQuestion(1);
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.draft.moveQuestion(-1);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.draft.moveQuestion(1);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.draft.moveQuestion(-1);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.draft.moveQuestion(1);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
      this.draft.moveCursor(-1);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
      this.draft.moveCursor(1);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorLineStart")) {
      this.draft.moveCursorTo("start");
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorLineEnd")) {
      this.draft.moveCursorTo("end");
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.draft.backspace();
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.deleteCharForward")) {
      this.draft.deleteForward();
      this.requestRender();
      return;
    }
    if (isPrintableInput(data)) {
      this.draft.insert(data);
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(12, width - 4);
    const body = this.renderQuestions(innerWidth);
    const viewportHeight = Math.max(5, Math.min(body.lines.length, this.tui.terminal.rows - 9));
    this.viewportOffset = keepVisible(
      this.viewportOffset,
      body.anchor,
      viewportHeight,
      body.lines.length,
    );
    const viewport = body.lines.slice(this.viewportOffset, this.viewportOffset + viewportHeight);
    while (viewport.length < viewportHeight) viewport.push("");
    const status = this.draft.validationMessage
      ? color(this.theme, "warning", this.draft.validationMessage)
      : color(
          this.theme,
          "dim",
          `Requested by ${this.draft.request.requestedByRunId}`,
        );
    const hints = color(
      this.theme,
      "dim",
      "Tab/↑↓ fields · Ctrl+Space suggestions · Enter next/submit · Ctrl+Enter submit · Esc cancel",
    );
    const rows = [
      ...(this.draft.request.form.description
        ? [...wrapPlain(this.draft.request.form.description, innerWidth), ""]
        : []),
      ...viewport,
      color(this.theme, "dim", "─".repeat(innerWidth)),
      status,
      hints,
    ];
    return [
      ...renderPanel({
        lines: rows,
        width,
        height: rows.length + 2,
        title: ` ${strong(this.theme, this.draft.request.form.title)}`,
        paddingX: 1,
        style: {
          surface: (line) => surface(this.theme, "customMessageBg", line),
          title: (line) => surface(this.theme, "selectedBg", line),
        },
      }).lines,
    ];
  }

  private renderQuestions(width: number): { readonly lines: string[]; readonly anchor: number } {
    const lines: string[] = [];
    let anchor = 0;
    this.draft.request.form.questions.forEach((question, index) => {
      const active = index === this.draft.activeQuestion;
      const label = `${index + 1}. ${question.prompt}${question.required ? " *" : ""}`;
      lines.push(
        ...wrapPlain(label, width).map((line) =>
          active ? strong(this.theme, line) : color(this.theme, "text", line),
        ),
      );
      if (question.description) {
        lines.push(...wrapPlain(question.description, width).map((line) => color(this.theme, "dim", line)));
      }
      question.suggestions.forEach((suggestion, suggestionIndex) => {
        const selected =
          active && this.draft.suggestionOpen && suggestionIndex === this.draft.suggestionIndex;
        if (selected) anchor = lines.length;
        const shortcut = String.fromCharCode(97 + suggestionIndex);
        const prefix = selected ? "›" : " ";
        const text = `${prefix} ${shortcut}) ${suggestion.label}${
          suggestion.description ? ` — ${suggestion.description}` : ""
        }`;
        const rendered = truncateToWidth(text, width);
        lines.push(
          selected
            ? surface(this.theme, "selectedBg", fitLine(rendered, width))
            : color(this.theme, "muted", rendered),
        );
      });
      const answerRow = lines.length;
      if (active && !this.draft.suggestionOpen) anchor = answerRow;
      lines.push(this.renderAnswer(question, index, width, active));
      if (index < this.draft.request.form.questions.length - 1) lines.push("");
    });
    return { lines, anchor };
  }

  private renderAnswer(
    question: UserFormQuestion,
    index: number,
    width: number,
    active: boolean,
  ): string {
    const prefix = active ? color(this.theme, "accent", "┃ Answer: ") : "│ Answer: ";
    const prefixWidth = visibleWidth(prefix);
    const answerWidth = Math.max(1, width - prefixWidth);
    const answer = this.draft.answer(index);
    const value = renderEditableValue(
      answer.value,
      answer.cursor,
      answerWidth,
      active,
      question.placeholder ?? "Enter answer",
      this.theme,
    );
    const line = fitLine(`${prefix}${value}`, width);
    return active ? surface(this.theme, "userMessageBg", line) : line;
  }

  private submit(): void {
    const completion = this.draft.completion();
    if (!completion) {
      this.requestRender();
      return;
    }
    this.close(completion);
  }

  private close(completion: UserFormCompletion): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(completion);
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}

function renderEditableValue(
  value: string,
  cursor: number,
  width: number,
  active: boolean,
  placeholder: string,
  theme: ObservabilityTheme,
): string {
  if (!value && !active) return color(theme, "dim", truncateToWidth(placeholder, width));
  if (!value) return `${CURSOR_MARKER}${color(theme, "dim", truncateToWidth(placeholder, width))}`;
  const characters = Array.from(value);
  const start = Math.max(0, Math.min(cursor, characters.length) - Math.max(1, width - 1));
  const visible = characters.slice(start, start + width);
  if (active) visible.splice(Math.max(0, cursor - start), 0, CURSOR_MARKER);
  return truncateToWidth(visible.join(""), width);
}

function suggestionShortcut(data: string): number | undefined {
  for (let index = 0; index < 8; index += 1) {
    if (matchesKey(data, `alt+${String.fromCharCode(97 + index)}`)) return index;
  }
  return undefined;
}

function isPrintableInput(data: string): boolean {
  return data.length > 0 && !Array.from(data).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function keepVisible(offset: number, anchor: number, height: number, total: number): number {
  const maximum = Math.max(0, total - height);
  if (anchor < offset) return Math.max(0, anchor);
  if (anchor >= offset + height) return Math.min(maximum, anchor - height + 1);
  return Math.min(maximum, offset);
}

function fitLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function wrapPlain(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      result.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (visibleWidth(candidate) <= limit) {
        line = candidate;
        continue;
      }
      if (line) result.push(line);
      line = truncateToWidth(word, limit);
    }
    result.push(line);
  }
  return result;
}
