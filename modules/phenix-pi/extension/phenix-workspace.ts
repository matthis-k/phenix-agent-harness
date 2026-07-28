import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import {
  AssistantMessageComponent,
  CustomEditor,
  getMarkdownTheme,
  getSelectListTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  type Component,
  matchesKey,
  type SlashCommand,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import type { TaskNode, TaskTree } from "../domain/task/projection.ts";
import type { NativeRunTranscript } from "./native-run-transcript.ts";
import {
  color,
  heading,
  type ObservabilityTheme,
  state,
  strong,
  surface,
} from "./observability-theme.ts";
import type { PhenixUiSnapshot, PhenixUiTarget } from "./phenix-ui.ts";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";
const SIDEBAR_MIN_WIDTH = 90;

export type WorkspaceFocus = "transcript" | "editor" | "runs" | "tasks" | "facts";
export type WorkspaceSection = "runs" | "tasks" | "facts";

export type PhenixWorkspaceAction =
  | { readonly kind: "close" }
  | { readonly kind: "native"; readonly text: string }
  | { readonly kind: "inspector"; readonly target: PhenixUiTarget };

export interface PhenixWorkspaceSnapshot {
  readonly ui: PhenixUiSnapshot;
  readonly tasks: TaskTree;
  readonly rootTranscript: NativeRunTranscript;
}

export interface PhenixWorkspaceOptions {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly keybindings: KeybindingsManager;
  readonly cwd: string;
  readonly commands: readonly SlashCommand[];
  readonly snapshot: PhenixWorkspaceSnapshot;
  readonly load: () => Promise<PhenixWorkspaceSnapshot>;
  readonly loadTranscript: (node: RunTreeNode) => Promise<NativeRunTranscript>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly submit: (text: string) => Promise<void>;
  readonly onAction: (action: PhenixWorkspaceAction) => void;
}

interface SectionState {
  selected: number;
  offset: number;
  collapsed: boolean;
}

interface FlatRun {
  readonly node: RunTreeNode;
  readonly depth: number;
}

interface FlatTask {
  readonly node: TaskNode;
  readonly depth: number;
}

interface SectionLayout {
  readonly section: WorkspaceSection;
  readonly start: number;
  readonly height: number;
}

interface MouseEvent {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
}

export interface WorkspaceLayout {
  readonly width: number;
  readonly height: number;
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly mainWidth: number;
}

export function computeWorkspaceLayout(
  width: number,
  height: number,
  sidebarRequested = true,
): WorkspaceLayout {
  const sidebarVisible = sidebarRequested && width >= SIDEBAR_MIN_WIDTH;
  const sidebarWidth = sidebarVisible ? Math.min(42, Math.max(32, Math.floor(width * 0.3))) : 0;
  return {
    width,
    height,
    sidebarVisible,
    sidebarWidth,
    mainWidth: Math.max(1, width - sidebarWidth - (sidebarVisible ? 1 : 0)),
  };
}

export function allocateWorkspaceSections(
  height: number,
  collapsed: Readonly<Record<WorkspaceSection, boolean>>,
): Readonly<Record<WorkspaceSection, number>> {
  const sections: readonly WorkspaceSection[] = ["runs", "tasks", "facts"];
  const minimum = 2;
  const result: Record<WorkspaceSection, number> = {
    runs: minimum,
    tasks: minimum,
    facts: minimum,
  };
  const remaining = Math.max(0, height - minimum * sections.length);
  const weights: Record<WorkspaceSection, number> = {
    runs: collapsed.runs ? 0 : 5,
    tasks: collapsed.tasks ? 0 : 2,
    facts: collapsed.facts ? 0 : 3,
  };
  const totalWeight = sections.reduce((sum, section) => sum + weights[section], 0);
  if (totalWeight === 0) return result;
  let assigned = 0;
  for (const section of sections) {
    const share = Math.floor((remaining * weights[section]) / totalWeight);
    result[section] += share;
    assigned += share;
  }
  let remainder = remaining - assigned;
  for (const section of sections) {
    if (remainder <= 0) break;
    if (weights[section] === 0) continue;
    result[section] += 1;
    remainder -= 1;
  }
  return result;
}

export function flattenWorkspaceRuns(root: RunTreeNode): readonly FlatRun[] {
  const result: FlatRun[] = [];
  const visit = (node: RunTreeNode, depth: number): void => {
    if (node.run.kind !== "root") result.push({ node, depth: Math.max(0, depth - 1) });
    const autoCollapsed =
      node.run.kind !== "root" && TERMINAL_STATES.has(node.run.state) && node.children.length > 0;
    if (autoCollapsed) return;
    node.children.forEach((child) => {
      visit(child, depth + 1);
    });
  };
  visit(root, 0);
  return result;
}

export function flattenWorkspaceTasks(root: TaskNode): readonly FlatTask[] {
  const result: FlatTask[] = [];
  const visit = (node: TaskNode, depth: number): void => {
    if (depth > 0) result.push({ node, depth: depth - 1 });
    if (node.effectiveState === "done" && node.children.length > 0) return;
    node.children.forEach((child) => {
      visit(child, depth + 1);
    });
  };
  visit(root, 0);
  return result;
}

export class PhenixWorkspace implements Component {
  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly load: () => Promise<PhenixWorkspaceSnapshot>;
  private readonly loadTranscript: (node: RunTreeNode) => Promise<NativeRunTranscript>;
  private readonly submit: (text: string) => Promise<void>;
  private readonly onAction: (action: PhenixWorkspaceAction) => void;
  private readonly unsubscribe: () => void;
  private readonly editor: CustomEditor;
  private snapshot: PhenixWorkspaceSnapshot;
  private focus: WorkspaceFocus = "editor";
  private selectedRunId: string;
  private selectedTranscript: NativeRunTranscript;
  private transcriptOffset = Number.MAX_SAFE_INTEGER;
  private streamingMessage: AssistantMessage | undefined;
  private refreshing = false;
  private pendingRefresh = false;
  private disposed = false;
  private sidebarRequested = true;
  private layout: WorkspaceLayout = computeWorkspaceLayout(1, 1);
  private sectionLayouts: readonly SectionLayout[] = [];
  private readonly sections: Record<WorkspaceSection, SectionState> = {
    runs: { selected: 0, offset: 0, collapsed: false },
    tasks: { selected: 0, offset: 0, collapsed: false },
    facts: { selected: 0, offset: 0, collapsed: false },
  };

  constructor(options: PhenixWorkspaceOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.load = options.load;
    this.loadTranscript = options.loadTranscript;
    this.submit = options.submit;
    this.onAction = options.onAction;
    this.snapshot = options.snapshot;
    this.selectedRunId = String(options.snapshot.ui.tree.root.run.id);
    this.selectedTranscript = options.snapshot.rootTranscript;
    this.editor = new CustomEditor(
      options.tui,
      {
        borderColor: (text) => options.theme.fg("muted", text),
        selectList: getSelectListTheme(),
      },
      options.keybindings,
      { paddingX: 1, autocompleteMaxVisible: 8 },
    );
    if (options.commands.length > 0) {
      this.editor.setAutocompleteProvider(
        new CombinedAutocompleteProvider([...options.commands], options.cwd),
      );
    }
    this.editor.onSubmit = (text) => {
      void this.handleSubmit(text);
    };
    this.unsubscribe = options.subscribe(() => {
      void this.refresh();
    });
    this.tui.terminal.write(MOUSE_ENABLE);
  }

  setStreamingMessage(message: AssistantMessage | undefined): void {
    this.streamingMessage = message;
    this.requestRender();
  }

  refreshRootTranscript(): void {
    void this.refresh();
  }

  invalidate(): void {
    this.selectedTranscript.component?.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.tui.terminal.write(MOUSE_DISABLE);
  }

  handleInput(data: string): void {
    const mouse = parseMouse(data);
    if (mouse) {
      this.handleMouse(mouse);
      return;
    }
    if (data === "\x0f") {
      this.onAction({ kind: "native", text: this.editor.getText() });
      return;
    }
    if (data === "\x02") {
      this.sidebarRequested = !this.sidebarRequested;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.cycleFocus(matchesKey(data, "shift+tab") ? -1 : 1);
      return;
    }
    if (this.focus === "editor") {
      this.editor.focused = true;
      this.editor.handleInput(data);
      return;
    }
    this.editor.focused = false;
    if (matchesKey(data, "escape")) {
      this.focus = "editor";
      this.requestRender();
      return;
    }
    if (data === "i" || data === "I") {
      this.openInspector();
      return;
    }
    if (this.focus === "transcript") {
      this.handleTranscriptInput(data);
      return;
    }
    this.handleSectionInput(this.focus, data);
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    this.layout = computeWorkspaceLayout(width, height, this.sidebarRequested);
    if (width < 42 || height < 9) return this.renderSmall(width, height);
    if (!this.layout.sidebarVisible && this.focus !== "transcript" && this.focus !== "editor") {
      this.focus = "editor";
    }
    this.editor.focused = this.focus === "editor";
    const editorLines = this.editor.render(this.layout.mainWidth);
    const mainHeight = Math.max(1, height - editorLines.length);
    const transcript = this.renderTranscript(this.layout.mainWidth, mainHeight);
    const main = [...transcript, ...editorLines];
    if (!this.layout.sidebarVisible) {
      return fitHeight(main, height, this.layout.mainWidth);
    }
    const sidebar = this.renderSidebar(this.layout.sidebarWidth, height);
    return Array.from({ length: height }, (_, row) => {
      const left = fitLine(main[row] ?? "", this.layout.mainWidth);
      const right = fitLine(sidebar[row] ?? "", this.layout.sidebarWidth);
      return `${left} ${right}`;
    });
  }

  private async handleSubmit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    if (text === "/phenix" || text === "/phenix ui") {
      this.editor.setText("");
      this.onAction({ kind: "inspector", target: { view: "status" } });
      return;
    }
    if (text.startsWith("/phenix ui ")) {
      const [view, ...selector] = text.slice("/phenix ui ".length).trim().split(/\s+/);
      const normalized = view === "run" ? "runs" : view === "fact" ? "facts" : view;
      if (["status", "runs", "facts", "catalog"].includes(normalized)) {
        this.editor.setText("");
        this.onAction({
          kind: "inspector",
          target: {
            view: normalized as PhenixUiTarget["view"],
            ...(selector.length > 0 ? { selector: selector.join(" ") } : {}),
          },
        });
        return;
      }
    }
    if (text.startsWith("/")) {
      this.editor.setText("");
      this.onAction({ kind: "native", text });
      return;
    }
    this.editor.addToHistory(text);
    this.editor.setText("");
    await this.submit(text);
  }

  private renderTranscript(width: number, height: number): string[] {
    const selected = findRun(this.snapshot.ui.tree.root, this.selectedRunId);
    const title =
      selected?.run.kind === "root"
        ? "Root session"
        : selected
          ? definitionLabel(String(selected.run.definitionId))
          : "Session";
    const session = this.selectedTranscript.sessionId;
    const header = surface(
      this.theme,
      this.focus === "transcript" ? "selectedBg" : "customMessageBg",
      fitLine(
        ` ${strong(this.theme, title)}${session ? ` ${color(this.theme, "muted", `· ${session}`)}` : ""}${selected?.run.kind !== "root" ? ` ${color(this.theme, "muted", "· Enter in Runs selects a child · i inspects")}` : ""}`,
        width,
      ),
    );
    const content: string[] = [header];
    if (this.selectedTranscript.unavailable) {
      content.push("", color(this.theme, "warning", ` ${this.selectedTranscript.unavailable}`));
    } else if (this.selectedTranscript.component) {
      content.push(...this.selectedTranscript.component.render(width));
    }
    if (selected?.run.kind === "root" && this.streamingMessage) {
      const streaming = new AssistantMessageComponent(
        this.streamingMessage,
        true,
        getMarkdownTheme(),
        "Thinking...",
        1,
      );
      content.push(...streaming.render(width));
    }
    const bodyHeight = Math.max(0, height - 1);
    const maxOffset = Math.max(0, content.length - height);
    this.transcriptOffset = clamp(this.transcriptOffset, 0, maxOffset);
    const lines = Array.from({ length: bodyHeight }, (_, row) =>
      fitLine(content[this.transcriptOffset + row + 1] ?? "", width),
    );
    return [header, ...lines];
  }

  private renderSidebar(width: number, height: number): string[] {
    const profile = this.snapshot.ui.profile;
    const diagnostics = this.snapshot.ui.diagnostics.counts;
    const active = countActive(this.snapshot.ui.tree.root);
    const header = [
      surface(
        this.theme,
        "customMessageBg",
        fitLine(
          ` ${strong(this.theme, "PHENIX")} ${color(this.theme, "muted", `${profile.agent}/${profile.modelSet}/${profile.difficulty}`)}`,
          width,
        ),
      ),
      surface(
        this.theme,
        "customMessageBg",
        fitLine(
          ` ${state(this.theme, active > 0 ? "running" : "completed", active > 0 ? `${active} active` : "idle")} ${color(this.theme, diagnostics.error > 0 ? "error" : diagnostics.warning > 0 ? "warning" : "success", diagnostics.error > 0 ? `${diagnostics.error} errors` : diagnostics.warning > 0 ? `${diagnostics.warning} warnings` : "healthy")}`,
          width,
        ),
      ),
    ];
    const available = Math.max(6, height - header.length);
    const sizes = allocateWorkspaceSections(available, {
      runs: this.sections.runs.collapsed,
      tasks: this.sections.tasks.collapsed,
      facts: this.sections.facts.collapsed,
    });
    const layouts: SectionLayout[] = [];
    let start = header.length;
    for (const section of ["runs", "tasks", "facts"] as const) {
      layouts.push({ section, start, height: sizes[section] });
      start += sizes[section];
    }
    this.sectionLayouts = layouts;
    return [
      ...header,
      ...this.renderRunSection(width, sizes.runs),
      ...this.renderTaskSection(width, sizes.tasks),
      ...this.renderFactSection(width, sizes.facts),
    ].slice(0, height);
  }

  private renderRunSection(width: number, height: number): string[] {
    const items = flattenWorkspaceRuns(this.snapshot.ui.tree.root);
    const section = this.sections.runs;
    section.selected = clamp(section.selected, 0, Math.max(0, items.length - 1));
    const title = this.sectionHeader("runs", `RUNS ${items.length}`, width);
    if (section.collapsed || height <= 1) return [title, ...blankLines(height - 1, width)];
    const bodyHeight = height - 1;
    section.offset = keepVisible(section.offset, section.selected, bodyHeight, items.length);
    const body = Array.from({ length: bodyHeight }, (_, row) => {
      const index = section.offset + row;
      const item = items[index];
      if (!item) return " ".repeat(width);
      const selected = this.focus === "runs" && index === section.selected;
      const run = item.node.run;
      const model = run.resolvedModel
        ? ` ${color(this.theme, "muted", `${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`)}`
        : "";
      const activity = item.node.activity?.summary
        ? ` ${color(this.theme, "muted", truncate(item.node.activity.summary, Math.max(12, width - 8 - item.depth * 2)))}`
        : "";
      const text = `${"  ".repeat(item.depth)}${runStateSymbol(run.state)} ${definitionLabel(String(run.definitionId))} ${run.state}${model}`;
      const line = fitLine(` ${text}`, width);
      if (selected) return surface(this.theme, "selectedBg", strong(this.theme, line));
      if (activity && !TERMINAL_STATES.has(run.state) && row + 1 < bodyHeight) {
        return fitLine(
          `${line.slice(0, Math.max(0, width - visibleWidth(activity)))}${activity}`,
          width,
        );
      }
      return line;
    });
    return [title, ...body];
  }

  private renderTaskSection(width: number, height: number): string[] {
    const items = flattenWorkspaceTasks(this.snapshot.tasks.root);
    const section = this.sections.tasks;
    section.selected = clamp(section.selected, 0, Math.max(0, items.length - 1));
    const title = this.sectionHeader("tasks", `TASKS ${items.length}`, width);
    if (section.collapsed || height <= 1) return [title, ...blankLines(height - 1, width)];
    const bodyHeight = height - 1;
    section.offset = keepVisible(section.offset, section.selected, bodyHeight, items.length);
    return [
      title,
      ...Array.from({ length: bodyHeight }, (_, row) => {
        const index = section.offset + row;
        const item = items[index];
        if (!item) return " ".repeat(width);
        const selected = this.focus === "tasks" && index === section.selected;
        const symbol = taskStateSymbol(item.node.effectiveState);
        const line = fitLine(
          ` ${"  ".repeat(item.depth)}${symbol} ${truncate(item.node.title, Math.max(8, width - 5 - item.depth * 2))}`,
          width,
        );
        return selected ? surface(this.theme, "selectedBg", strong(this.theme, line)) : line;
      }),
    ];
  }

  private renderFactSection(width: number, height: number): string[] {
    const items = [...this.snapshot.ui.facts].reverse().slice(0, 50);
    const section = this.sections.facts;
    section.selected = clamp(section.selected, 0, Math.max(0, items.length - 1));
    const title = this.sectionHeader("facts", `RECENT FACTS ${items.length}`, width);
    if (section.collapsed || height <= 1) return [title, ...blankLines(height - 1, width)];
    const bodyHeight = height - 1;
    section.offset = keepVisible(section.offset, section.selected, bodyHeight, items.length);
    return [
      title,
      ...Array.from({ length: bodyHeight }, (_, row) => {
        const index = section.offset + row;
        const item = items[index];
        if (!item) return " ".repeat(width);
        const selected = this.focus === "facts" && index === section.selected;
        const line = fitLine(
          ` ${compactTime(item.timestamp)} ${truncate(item.summary, Math.max(8, width - 8))}`,
          width,
        );
        return selected
          ? surface(this.theme, "selectedBg", strong(this.theme, line))
          : color(this.theme, "muted", line);
      }),
    ];
  }

  private sectionHeader(section: WorkspaceSection, title: string, width: number): string {
    const active = this.focus === section;
    const disclosure = this.sections[section].collapsed ? "▸" : "▾";
    return surface(
      this.theme,
      active ? "userMessageBg" : "customMessageBg",
      fitLine(
        ` ${disclosure} ${active ? strong(this.theme, title) : heading(this.theme, title)}`,
        width,
      ),
    );
  }

  private handleTranscriptInput(data: string): void {
    if (isUp(data)) this.transcriptOffset = Math.max(0, this.transcriptOffset - 1);
    else if (isDown(data)) this.transcriptOffset += 1;
    else if (matchesKey(data, "pageUp"))
      this.transcriptOffset = Math.max(
        0,
        this.transcriptOffset - Math.max(1, this.layout.height - 4),
      );
    else if (matchesKey(data, "pageDown"))
      this.transcriptOffset += Math.max(1, this.layout.height - 4);
    else if (matchesKey(data, "home")) this.transcriptOffset = 0;
    else if (matchesKey(data, "end")) this.transcriptOffset = Number.MAX_SAFE_INTEGER;
    else return;
    this.requestRender();
  }

  private handleSectionInput(section: WorkspaceSection, data: string): void {
    const state = this.sections[section];
    const count = this.sectionItemCount(section);
    if (isUp(data)) state.selected -= 1;
    else if (isDown(data)) state.selected += 1;
    else if (matchesKey(data, "home")) state.selected = 0;
    else if (matchesKey(data, "end")) state.selected = count - 1;
    else if (data === " ") state.collapsed = !state.collapsed;
    else if (matchesKey(data, "enter")) {
      void this.activateSection(section);
      return;
    } else return;
    state.selected = clamp(state.selected, 0, Math.max(0, count - 1));
    this.requestRender();
  }

  private async activateSection(section: WorkspaceSection): Promise<void> {
    if (section === "runs") {
      const item = flattenWorkspaceRuns(this.snapshot.ui.tree.root)[this.sections.runs.selected];
      if (!item) return;
      await this.selectTranscript(item.node);
      return;
    }
    if (section === "tasks") {
      const item = flattenWorkspaceTasks(this.snapshot.tasks.root)[this.sections.tasks.selected];
      if (item?.node.kind === "execution") {
        const run = findRun(this.snapshot.ui.tree.root, String(item.node.runId));
        if (run) await this.selectTranscript(run);
      }
      return;
    }
    this.onAction({ kind: "inspector", target: { view: "facts" } });
  }

  private async selectTranscript(node: RunTreeNode): Promise<void> {
    this.selectedRunId = String(node.run.id);
    this.focus = "transcript";
    this.transcriptOffset = Number.MAX_SAFE_INTEGER;
    this.selectedTranscript = await this.loadTranscript(node);
    if (!this.disposed) this.requestRender();
  }

  private openInspector(): void {
    const selected = findRun(this.snapshot.ui.tree.root, this.selectedRunId);
    this.onAction({
      kind: "inspector",
      target:
        selected?.run.kind === "root"
          ? { view: "status" }
          : { view: "runs", selector: this.selectedRunId },
    });
  }

  private cycleFocus(delta: number): void {
    const order: WorkspaceFocus[] = this.layout.sidebarVisible
      ? ["transcript", "editor", "runs", "tasks", "facts"]
      : ["transcript", "editor"];
    const index = Math.max(0, order.indexOf(this.focus));
    this.focus = order[(index + delta + order.length) % order.length] ?? "editor";
    this.editor.focused = this.focus === "editor";
    this.requestRender();
  }

  private handleMouse(event: MouseEvent): void {
    if (event.release) return;
    if (!this.layout.sidebarVisible || event.x <= this.layout.mainWidth) {
      if (event.button === 64 || event.button === 65) {
        this.focus = "transcript";
        this.transcriptOffset = Math.max(0, this.transcriptOffset + (event.button === 64 ? -3 : 3));
        this.requestRender();
      }
      return;
    }
    const section = this.sectionLayouts.find(
      (candidate) => event.y > candidate.start && event.y <= candidate.start + candidate.height,
    );
    if (!section) return;
    this.focus = section.section;
    const state = this.sections[section.section];
    if (event.button === 64 || event.button === 65) {
      state.offset = Math.max(0, state.offset + (event.button === 64 ? -2 : 2));
      state.selected = state.offset;
      this.requestRender();
      return;
    }
    if (event.button !== 0) return;
    const row = event.y - section.start - 2;
    if (row >= 0) {
      state.selected = clamp(
        state.offset + row,
        0,
        Math.max(0, this.sectionItemCount(section.section) - 1),
      );
      this.requestRender();
    }
  }

  private sectionItemCount(section: WorkspaceSection): number {
    if (section === "runs") return flattenWorkspaceRuns(this.snapshot.ui.tree.root).length;
    if (section === "tasks") return flattenWorkspaceTasks(this.snapshot.tasks.root).length;
    return Math.min(50, this.snapshot.ui.facts.length);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshing) {
      this.pendingRefresh = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.pendingRefresh = false;
        const next = await this.load();
        if (this.disposed) return;
        this.snapshot = next;
        const selected = findRun(next.ui.tree.root, this.selectedRunId);
        if (!selected || selected.run.kind === "root") {
          this.selectedRunId = String(next.ui.tree.root.run.id);
          this.selectedTranscript = next.rootTranscript;
        } else {
          this.selectedTranscript = await this.loadTranscript(selected);
        }
        this.requestRender();
      } while (this.pendingRefresh && !this.disposed);
    } finally {
      this.refreshing = false;
    }
  }

  private renderSmall(width: number, height: number): string[] {
    return fitHeight(
      [
        heading(this.theme, " Phenix workspace"),
        color(this.theme, "warning", " Terminal is too small."),
        " Resize to at least 42 columns and 9 rows.",
        " Ctrl+O returns to Pi's native UI.",
      ].map((line) => fitLine(line, width)),
      height,
      width,
    );
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}

function findRun(root: RunTreeNode, id: string): RunTreeNode | undefined {
  if (String(root.run.id) === id) return root;
  for (const child of root.children) {
    const found = findRun(child, id);
    if (found) return found;
  }
  return undefined;
}

function countActive(node: RunTreeNode): number {
  return (
    (node.run.kind !== "root" && !TERMINAL_STATES.has(node.run.state) ? 1 : 0) +
    node.children.reduce((sum, child) => sum + countActive(child), 0)
  );
}

function parseMouse(data: string): MouseEvent | undefined {
  if (!data.startsWith("\x1b[<")) return undefined;
  const match = /^(\d+);(\d+);(\d+)([Mm])$/.exec(data.slice(3));
  if (!match) return undefined;
  return {
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    release: match[4] === "m",
  };
}

function runStateSymbol(value: RunSnapshot["state"]): string {
  if (value === "completed") return "✓";
  if (value === "failed" || value === "orphaned") return "✗";
  if (value === "cancelled") return "−";
  if (value === "waiting") return "○";
  return "●";
}

function taskStateSymbol(value: TaskNode["effectiveState"]): string {
  if (value === "done") return "✓";
  if (value === "failed") return "!";
  if (value === "wip") return "●";
  return "○";
}

function definitionLabel(value: string): string {
  return value.replace(/^(?:agent|workflow|session)\./, "");
}

function compactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 5);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function truncate(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), width > 1 ? "…" : "");
}

function fitLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function fitHeight(lines: readonly string[], height: number, width: number): string[] {
  return Array.from({ length: height }, (_, row) => fitLine(lines[row] ?? "", width));
}

function blankLines(count: number, width: number): string[] {
  return Array.from({ length: Math.max(0, count) }, () => " ".repeat(width));
}

function keepVisible(offset: number, selected: number, height: number, total: number): number {
  const max = Math.max(0, total - height);
  let next = clamp(offset, 0, max);
  if (selected < next) next = selected;
  if (selected >= next + height) next = selected - height + 1;
  return clamp(next, 0, max);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function isUp(data: string): boolean {
  return matchesKey(data, "up") || data === "k";
}

function isDown(data: string): boolean {
  return matchesKey(data, "down") || data === "j";
}
