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
  sliceByColumn,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import type { TaskNode } from "../domain/task/projection.ts";
import { allocateSidebarSections } from "../domain/workspace/layout.ts";
import type { PaneId, ScrollState } from "../domain/workspace/state.ts";
import type { NativeRunTranscript } from "./native-run-transcript.ts";
import {
  color,
  heading,
  type ObservabilityTheme,
  state,
  strong,
  surface,
} from "./observability-theme.ts";
import type { PhenixUiTarget } from "./phenix-ui.ts";
import { WorkspaceControllerAdapter } from "./workspace/workspace-controller-adapter.ts";
import {
  findWorkspaceRun,
  type PhenixWorkspaceSnapshot,
  projectWorkspaceRuns,
  projectWorkspaceTasks,
  type WorkspaceRunRow,
} from "./workspace/workspace-model.ts";

export type { PhenixWorkspaceSnapshot } from "./workspace/workspace-model.ts";

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

interface SectionLayout {
  readonly section: WorkspaceSection;
  readonly start: number;
  readonly height: number;
  readonly offset: number;
}

interface MouseEvent {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
}

interface SidebarRender {
  readonly lines: readonly string[];
  readonly layouts: readonly SectionLayout[];
}

interface TranscriptRender {
  readonly lines: readonly string[];
  readonly maxOffset: number;
}

interface RenderFrame {
  readonly layout: WorkspaceLayout;
  readonly sections: readonly SectionLayout[];
  readonly transcriptMaxOffset: number;
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
  const frames = allocateSidebarSections(height, [
    {
      id: "runs",
      weight: 5,
      minRows: 2,
      headerRows: 2,
      collapsePriority: 0,
      collapsed: collapsed.runs,
    },
    {
      id: "tasks",
      weight: 2,
      minRows: 2,
      headerRows: 2,
      collapsePriority: 20,
      collapsed: collapsed.tasks,
    },
    {
      id: "facts",
      weight: 3,
      minRows: 2,
      headerRows: 2,
      collapsePriority: 40,
      collapsed: collapsed.facts,
    },
  ]);
  return {
    runs: frames.find((frame) => frame.id === "runs")?.height ?? 0,
    tasks: frames.find((frame) => frame.id === "tasks")?.height ?? 0,
    facts: frames.find((frame) => frame.id === "facts")?.height ?? 0,
  };
}

export const flattenWorkspaceRuns = projectWorkspaceRuns;
export const flattenWorkspaceTasks = projectWorkspaceTasks;

export class PhenixWorkspace implements Component {
  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly submit: (text: string) => Promise<void>;
  private readonly onAction: (action: PhenixWorkspaceAction) => void;
  private readonly editor: CustomEditor;
  private readonly controller: WorkspaceControllerAdapter;
  private streamingMessage: AssistantMessage | undefined;
  private disposed = false;
  private frame: RenderFrame = {
    layout: computeWorkspaceLayout(1, 1),
    sections: [],
    transcriptMaxOffset: 0,
  };

  constructor(options: PhenixWorkspaceOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.submit = options.submit;
    this.onAction = options.onAction;
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
    this.controller = new WorkspaceControllerAdapter({
      snapshot: options.snapshot,
      load: options.load,
      loadTranscript: options.loadTranscript,
      subscribe: options.subscribe,
      onChange: () => this.requestRender(),
    });
    this.tui.terminal.write(MOUSE_ENABLE);
  }

  setStreamingMessage(message: AssistantMessage | undefined): void {
    this.streamingMessage = message;
    this.requestRender();
  }

  refreshRootTranscript(): void {
    this.controller.invalidateSnapshot();
  }

  invalidate(): void {
    this.controller.transcript.component?.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.dispose();
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
      this.controller.dispatch({ type: "sidebar.toggle" });
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.cycleFocus(matchesKey(data, "shift+tab") ? -1 : 1);
      return;
    }

    const focus = this.effectiveFocus();
    if (focus === "editor") {
      this.editor.focused = true;
      this.editor.handleInput(data);
      return;
    }
    this.editor.focused = false;
    if (matchesKey(data, "escape")) {
      this.controller.dispatch({ type: "focus.set", paneId: "editor" });
      return;
    }
    if (data === "i" || data === "I") {
      this.openInspector();
      return;
    }
    if (focus === "transcript") {
      this.handleTranscriptInput(data);
      return;
    }
    this.handleSectionInput(focus, data);
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    const layout = computeWorkspaceLayout(width, height, this.controller.state.sidebarVisible);
    if (width < 42 || height < 9) {
      this.frame = { layout, sections: [], transcriptMaxOffset: 0 };
      return this.renderSmall(width, height);
    }

    const focus = effectiveFocus(this.controller.state.focusedPaneId, layout.sidebarVisible);
    this.editor.focused = focus === "editor";
    const editorLines = this.editor.render(layout.mainWidth);
    const mainHeight = Math.max(1, height - editorLines.length);
    const transcript = this.renderTranscript(layout.mainWidth, mainHeight, focus);
    const main = [...transcript.lines, ...editorLines];

    if (!layout.sidebarVisible) {
      this.frame = { layout, sections: [], transcriptMaxOffset: transcript.maxOffset };
      return fitHeight(main, height, layout.mainWidth);
    }

    const sidebar = this.renderSidebar(layout.sidebarWidth, height, focus);
    this.frame = {
      layout,
      sections: sidebar.layouts,
      transcriptMaxOffset: transcript.maxOffset,
    };
    return Array.from({ length: height }, (_, row) => {
      const left = fitLine(main[row] ?? "", layout.mainWidth);
      const right = fitLine(sidebar.lines[row] ?? "", layout.sidebarWidth);
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

  private renderTranscript(width: number, height: number, focus: WorkspaceFocus): TranscriptRender {
    const snapshot = this.controller.snapshot;
    const selected = findWorkspaceRun(
      snapshot.ui.tree.root,
      String(this.controller.state.activeRunId),
    );
    const title =
      selected?.run.kind === "root"
        ? "Root session"
        : selected
          ? definitionLabel(String(selected.run.definitionId))
          : "Session";
    const transcript = this.controller.transcript;
    const session = transcript.sessionId;
    const header = surface(
      this.theme,
      focus === "transcript" ? "selectedBg" : "customMessageBg",
      fitLine(
        ` ${strong(this.theme, title)}${session ? ` ${color(this.theme, "muted", `· ${session}`)}` : ""}${selected?.run.kind !== "root" ? ` ${color(this.theme, "muted", "· i inspects")}` : ""}`,
        width,
      ),
    );
    const content: string[] = [header];
    if (transcript.unavailable) {
      content.push("", color(this.theme, "warning", ` ${transcript.unavailable}`));
    } else if (transcript.component) {
      content.push(...transcript.component.render(width).map((line) => leftOrigin(line, width)));
    }
    if (selected?.run.kind === "root" && this.streamingMessage) {
      const streaming = new AssistantMessageComponent(
        this.streamingMessage,
        true,
        getMarkdownTheme(),
        "Thinking...",
        1,
      );
      content.push(...streaming.render(width).map((line) => leftOrigin(line, width)));
    }

    const bodyHeight = Math.max(0, height - 1);
    const maxOffset = Math.max(0, content.length - height);
    const scroll = this.controller.state.transcript.scroll;
    const offset = scroll.mode === "follow-end" ? maxOffset : clamp(scroll.offset, 0, maxOffset);
    const lines = Array.from({ length: bodyHeight }, (_, row) =>
      leftOrigin(content[offset + row + 1] ?? "", width),
    );
    return { lines: [header, ...lines], maxOffset };
  }

  private renderSidebar(width: number, height: number, focus: WorkspaceFocus): SidebarRender {
    const snapshot = this.controller.snapshot;
    const profile = snapshot.ui.profile;
    const diagnostics = snapshot.ui.diagnostics.counts;
    const active = countActive(snapshot.ui.tree.root);
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
    const available = Math.max(0, height - header.length);
    const sizes = allocateWorkspaceSections(available, {
      runs: this.controller.state.panes.runs.collapsed,
      tasks: this.controller.state.panes.tasks.collapsed,
      facts: this.controller.state.panes.facts.collapsed,
    });

    const runs = this.renderRunSection(width, sizes.runs, focus);
    const tasks = this.renderTaskSection(width, sizes.tasks, focus);
    const facts = this.renderFactSection(width, sizes.facts, focus);
    const layouts: SectionLayout[] = [];
    let start = header.length;
    for (const section of [runs, tasks, facts]) {
      layouts.push({
        section: section.section,
        start,
        height: section.lines.length,
        offset: section.offset,
      });
      start += section.lines.length;
    }

    return {
      lines: fitHeight([...header, ...runs.lines, ...tasks.lines, ...facts.lines], height, width),
      layouts,
    };
  }

  private renderRunSection(width: number, height: number, focus: WorkspaceFocus): SectionRender {
    const items = projectWorkspaceRuns(this.controller.snapshot.ui.tree.root);
    const pane = this.controller.state.panes.runs;
    const selectedIndex = rowIndex(items, pane.selectedItemId, (item) => String(item.node.run.id));
    if (height <= 0) return { section: "runs", lines: [], offset: 0 };
    const title = this.sectionHeader("runs", `RUNS ${items.length}`, width, focus);
    if (pane.collapsed || height === 1) {
      return {
        section: "runs",
        lines: [title, ...blankLines(height - 1, width)],
        offset: 0,
      };
    }
    const bodyHeight = height - 1;
    const offset = keepVisible(scrollOffset(pane.scroll), selectedIndex, bodyHeight, items.length);
    const body = Array.from({ length: bodyHeight }, (_, row) => {
      const item = items[offset + row];
      if (!item) return " ".repeat(width);
      return this.renderRunRow(item, width, focus);
    });
    return { section: "runs", lines: [title, ...body], offset };
  }

  private renderRunRow(item: WorkspaceRunRow, width: number, focus: WorkspaceFocus): string {
    const run = item.node.run;
    const runId = String(run.id);
    const active = runId === String(this.controller.state.activeRunId);
    const selected = runId === this.controller.state.panes.runs.selectedItemId;
    const model = run.resolvedModel
      ? ` ${color(this.theme, "muted", `${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`)}`
      : "";
    const activity = item.node.activity?.summary
      ? ` ${color(this.theme, "muted", truncate(item.node.activity.summary, Math.max(8, width - 24 - item.depth * 2)))}`
      : "";
    const label = run.kind === "root" ? "Root session" : definitionLabel(String(run.definitionId));
    const line = fitLine(
      ` ${active ? "◆" : " "} ${"  ".repeat(item.depth)}${runStateSymbol(run.state)} ${label} ${run.state}${model}${TERMINAL_STATES.has(run.state) ? "" : activity}`,
      width,
    );
    if (selected) {
      return surface(
        this.theme,
        focus === "runs" ? "selectedBg" : "userMessageBg",
        focus === "runs" ? strong(this.theme, line) : line,
      );
    }
    return active ? surface(this.theme, "customMessageBg", line) : line;
  }

  private renderTaskSection(width: number, height: number, focus: WorkspaceFocus): SectionRender {
    const items = projectWorkspaceTasks(this.controller.snapshot.tasks.root);
    const pane = this.controller.state.panes.tasks;
    const selectedIndex = rowIndex(items, pane.selectedItemId, (item) => item.node.id);
    if (height <= 0) return { section: "tasks", lines: [], offset: 0 };
    const title = this.sectionHeader("tasks", `TASKS ${items.length}`, width, focus);
    if (pane.collapsed || height === 1) {
      return {
        section: "tasks",
        lines: [title, ...blankLines(height - 1, width)],
        offset: 0,
      };
    }
    const bodyHeight = height - 1;
    const offset = keepVisible(scrollOffset(pane.scroll), selectedIndex, bodyHeight, items.length);
    const body = Array.from({ length: bodyHeight }, (_, row) => {
      const item = items[offset + row];
      if (!item) return " ".repeat(width);
      const selected = item.node.id === pane.selectedItemId;
      const symbol = taskStateSymbol(item.node.effectiveState);
      const line = fitLine(
        ` ${"  ".repeat(item.depth)}${symbol} ${truncate(item.node.title, Math.max(8, width - 5 - item.depth * 2))}`,
        width,
      );
      if (!selected) return line;
      return surface(
        this.theme,
        focus === "tasks" ? "selectedBg" : "userMessageBg",
        focus === "tasks" ? strong(this.theme, line) : line,
      );
    });
    return { section: "tasks", lines: [title, ...body], offset };
  }

  private renderFactSection(width: number, height: number, focus: WorkspaceFocus): SectionRender {
    const items = [...this.controller.snapshot.ui.facts].reverse().slice(0, 50);
    const pane = this.controller.state.panes.facts;
    const selectedIndex = rowIndex(items, pane.selectedItemId, (item) => item.id);
    if (height <= 0) return { section: "facts", lines: [], offset: 0 };
    const title = this.sectionHeader("facts", `RECENT FACTS ${items.length}`, width, focus);
    if (pane.collapsed || height === 1) {
      return {
        section: "facts",
        lines: [title, ...blankLines(height - 1, width)],
        offset: 0,
      };
    }
    const bodyHeight = height - 1;
    const offset = keepVisible(scrollOffset(pane.scroll), selectedIndex, bodyHeight, items.length);
    const body = Array.from({ length: bodyHeight }, (_, row) => {
      const item = items[offset + row];
      if (!item) return " ".repeat(width);
      const selected = item.id === pane.selectedItemId;
      const line = fitLine(
        ` ${compactTime(item.timestamp)} ${truncate(item.summary, Math.max(8, width - 8))}`,
        width,
      );
      if (selected) {
        return surface(
          this.theme,
          focus === "facts" ? "selectedBg" : "userMessageBg",
          focus === "facts" ? strong(this.theme, line) : line,
        );
      }
      return color(this.theme, "muted", line);
    });
    return { section: "facts", lines: [title, ...body], offset };
  }

  private sectionHeader(
    section: WorkspaceSection,
    title: string,
    width: number,
    focus: WorkspaceFocus,
  ): string {
    const active = focus === section;
    const disclosure = this.controller.state.panes[section].collapsed ? "▸" : "▾";
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
    const current = transcriptOffset(
      this.controller.state.transcript.scroll,
      this.frame.transcriptMaxOffset,
    );
    if (isUp(data)) this.setTranscriptOffset(current - 1);
    else if (isDown(data)) this.setTranscriptOffset(current + 1);
    else if (matchesKey(data, "pageUp")) {
      this.setTranscriptOffset(current - Math.max(1, this.frame.layout.height - 4));
    } else if (matchesKey(data, "pageDown")) {
      this.setTranscriptOffset(current + Math.max(1, this.frame.layout.height - 4));
    } else if (matchesKey(data, "home")) {
      this.setTranscriptOffset(0);
    } else if (matchesKey(data, "end")) {
      this.controller.dispatch({ type: "scroll.end", paneId: "transcript" });
    }
  }

  private setTranscriptOffset(value: number): void {
    const offset = clamp(value, 0, this.frame.transcriptMaxOffset);
    if (offset >= this.frame.transcriptMaxOffset) {
      this.controller.dispatch({ type: "scroll.end", paneId: "transcript" });
      return;
    }
    this.controller.dispatch({
      type: "scroll.set",
      paneId: "transcript",
      scroll: { mode: "fixed", offset },
    });
  }

  private handleSectionInput(section: WorkspaceSection, data: string): void {
    const itemIds = this.sectionItemIds(section);
    if (isUp(data)) {
      this.controller.dispatch({ type: "selection.move", paneId: section, direction: -1, itemIds });
    } else if (isDown(data)) {
      this.controller.dispatch({ type: "selection.move", paneId: section, direction: 1, itemIds });
    } else if (matchesKey(data, "home")) {
      this.controller.dispatch({ type: "selection.edge", paneId: section, edge: "first", itemIds });
    } else if (matchesKey(data, "end")) {
      this.controller.dispatch({ type: "selection.edge", paneId: section, edge: "last", itemIds });
    } else if (data === " ") {
      this.controller.dispatch({ type: "section.toggle", paneId: section });
    } else if (matchesKey(data, "enter")) {
      this.activateSection(section);
    }
  }

  private activateSection(section: WorkspaceSection): void {
    if (section === "runs") {
      const selectedRunId = this.controller.state.panes.runs.selectedItemId;
      if (!selectedRunId) return;
      const run = findWorkspaceRun(this.controller.snapshot.ui.tree.root, selectedRunId);
      if (run) this.selectTranscript(run);
      return;
    }
    if (section === "tasks") {
      const selectedTaskId = this.controller.state.panes.tasks.selectedItemId;
      const task = projectWorkspaceTasks(this.controller.snapshot.tasks.root).find(
        (item) => item.node.id === selectedTaskId,
      );
      if (task?.node.kind === "execution") {
        const run = findWorkspaceRun(
          this.controller.snapshot.ui.tree.root,
          String(task.node.runId),
        );
        if (run) this.selectTranscript(run);
      }
      return;
    }
    this.onAction({ kind: "inspector", target: { view: "facts" } });
  }

  private selectTranscript(node: RunTreeNode): void {
    this.controller.dispatch({ type: "focus.set", paneId: "transcript" });
    this.controller.selectTranscript(node.run.id);
  }

  private openInspector(): void {
    const activeRunId = String(this.controller.state.activeRunId);
    const selected = findWorkspaceRun(this.controller.snapshot.ui.tree.root, activeRunId);
    this.onAction({
      kind: "inspector",
      target:
        selected?.run.kind === "root"
          ? { view: "status" }
          : { view: "runs", selector: activeRunId },
    });
  }

  private cycleFocus(delta: 1 | -1): void {
    const order: readonly PaneId[] = this.frame.layout.sidebarVisible
      ? ["transcript", "editor", "runs", "tasks", "facts"]
      : ["transcript", "editor"];
    this.controller.dispatch({ type: "focus.move", direction: delta, order });
  }

  private handleMouse(event: MouseEvent): void {
    if (event.release) return;
    if (!this.frame.layout.sidebarVisible || event.x <= this.frame.layout.mainWidth) {
      if (event.button === 64 || event.button === 65) {
        this.controller.dispatch({ type: "focus.set", paneId: "transcript" });
        const current = transcriptOffset(
          this.controller.state.transcript.scroll,
          this.frame.transcriptMaxOffset,
        );
        this.setTranscriptOffset(current + (event.button === 64 ? -3 : 3));
      }
      return;
    }

    const section = this.frame.sections.find(
      (candidate) =>
        candidate.height > 0 &&
        event.y > candidate.start &&
        event.y <= candidate.start + candidate.height,
    );
    if (!section) return;
    this.controller.dispatch({ type: "focus.set", paneId: section.section });
    const itemIds = this.sectionItemIds(section.section);
    if (event.button === 64 || event.button === 65) {
      const offset = clamp(
        section.offset + (event.button === 64 ? -2 : 2),
        0,
        Math.max(0, itemIds.length - 1),
      );
      this.controller.dispatch({
        type: "scroll.set",
        paneId: section.section,
        scroll: { mode: "fixed", offset },
      });
      const selectedItemId = itemIds[offset];
      if (selectedItemId) {
        this.controller.dispatch({
          type: "selection.set",
          paneId: section.section,
          itemId: selectedItemId,
        });
      }
      return;
    }
    if (event.button !== 0) return;
    const row = event.y - section.start - 2;
    const selectedItemId = row >= 0 ? itemIds[section.offset + row] : undefined;
    if (selectedItemId) {
      this.controller.dispatch({
        type: "selection.set",
        paneId: section.section,
        itemId: selectedItemId,
      });
    }
  }

  private sectionItemIds(section: WorkspaceSection): readonly string[] {
    if (section === "runs") {
      return projectWorkspaceRuns(this.controller.snapshot.ui.tree.root).map((item) =>
        String(item.node.run.id),
      );
    }
    if (section === "tasks") {
      return projectWorkspaceTasks(this.controller.snapshot.tasks.root).map((item) => item.node.id);
    }
    return [...this.controller.snapshot.ui.facts]
      .reverse()
      .slice(0, 50)
      .map((item) => item.id);
  }

  private effectiveFocus(): WorkspaceFocus {
    return effectiveFocus(this.controller.state.focusedPaneId, this.frame.layout.sidebarVisible);
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

interface SectionRender {
  readonly section: WorkspaceSection;
  readonly lines: readonly string[];
  readonly offset: number;
}

function effectiveFocus(paneId: PaneId, sidebarVisible: boolean): WorkspaceFocus {
  if (paneId === "transcript" || paneId === "editor") return paneId;
  if (sidebarVisible && (paneId === "runs" || paneId === "tasks" || paneId === "facts")) {
    return paneId;
  }
  return "editor";
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

function leftOrigin(line: string, width: number): string {
  return fitLine(sliceByColumn(line, 0, Math.max(0, width), true), width);
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

function scrollOffset(scroll: ScrollState): number {
  return scroll.mode === "fixed" ? scroll.offset : 0;
}

function transcriptOffset(scroll: ScrollState, maximum: number): number {
  return scroll.mode === "follow-end" ? maximum : clamp(scroll.offset, 0, maximum);
}

function rowIndex<T>(
  items: readonly T[],
  selectedItemId: string | undefined,
  itemId: (item: T) => string,
): number {
  if (items.length === 0) return 0;
  const index = selectedItemId ? items.findIndex((item) => itemId(item) === selectedItemId) : -1;
  return index >= 0 ? index : 0;
}

function keepVisible(offset: number, selected: number, height: number, total: number): number {
  const maximum = Math.max(0, total - Math.max(0, height));
  let next = clamp(offset, 0, maximum);
  if (selected < next) next = selected;
  if (selected >= next + height) next = selected - height + 1;
  return clamp(next, 0, maximum);
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
