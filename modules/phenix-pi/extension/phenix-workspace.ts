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
  CURSOR_MARKER,
  type Focusable,
  type SlashCommand,
  sliceByColumn,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import { allocateSidebarSections, type LayoutFrame } from "../domain/workspace/layout.ts";
import type { PaneId, ScrollState } from "../domain/workspace/state.ts";
import type { LoadedWorkspaceTranscript } from "../ports/workspace-effects.ts";
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
import { transcriptAvailabilityMessage } from "./transcript-availability.ts";
import { renderWorkspaceComposer } from "./workspace/workspace-composer.ts";
import {
  nextWorkspaceSection,
  resolveWorkspaceInput,
} from "./workspace/workspace-interaction.ts";
import { stripTranscriptAnsi } from "./workspace/transcript-selection.ts";
import { TranscriptSelectionSurface } from "./workspace/transcript-selection-surface.ts";
import type {
  WorkspaceViewPaneId,
  WorkspaceViewRegistration,
  WorkspaceViewRow,
} from "./workspace/views/workspace-view.ts";
import { workspaceViewRegistry } from "./workspace/views/workspace-view-registry.ts";
import { WorkspaceControllerAdapter } from "./workspace/workspace-controller-adapter.ts";
import {
  composeWorkspaceTextFrame,
  computeWorkspaceDimensions,
  paneRect,
  solveWorkspaceLayout,
  type WorkspaceDimensions,
  type WorkspacePaneOutput,
} from "./workspace/workspace-layout-frame.ts";
import {
  findWorkspaceRun,
  type PhenixWorkspaceSnapshot,
  projectWorkspaceRuns,
  projectWorkspaceTasks,
} from "./workspace/workspace-model.ts";

export type { PhenixWorkspaceSnapshot } from "./workspace/workspace-model.ts";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

export type WorkspaceFocus = "main" | WorkspaceViewPaneId;
export type WorkspaceSection = WorkspaceViewPaneId;

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
  readonly loadTranscript: (
    node: RunTreeNode,
  ) => Promise<LoadedWorkspaceTranscript<NativeRunTranscript>>;
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

interface SectionRender {
  readonly section: WorkspaceSection;
  readonly lines: readonly string[];
  readonly offset: number;
}

interface TranscriptRender {
  readonly lines: readonly string[];
  readonly maxOffset: number;
  readonly offset: number;
  readonly plainLines: readonly string[];
}

interface RenderFrame {
  readonly layout: LayoutFrame;
  readonly sections: readonly SectionLayout[];
  readonly transcriptMaxOffset: number;
  readonly transcriptOffset: number;
  readonly transcriptLines: readonly string[];
}

export type WorkspaceLayout = WorkspaceDimensions;
export const computeWorkspaceLayout = computeWorkspaceDimensions;

export function allocateWorkspaceSections(
  height: number,
  collapsed: Readonly<Record<WorkspaceSection, boolean>>,
): Readonly<Record<WorkspaceSection, number>> {
  const frames = allocateSidebarSections(
    height,
    workspaceViewRegistry.ordered.map((view) => ({
      id: view.id,
      ...view.layout,
      collapsed: collapsed[view.id],
    })),
  );
  return Object.fromEntries(
    workspaceViewRegistry.ordered.map((view) => [
      view.id,
      frames.find((frame) => frame.id === view.id)?.height ?? 0,
    ]),
  ) as Readonly<Record<WorkspaceSection, number>>;
}

export const flattenWorkspaceRuns = projectWorkspaceRuns;
export const flattenWorkspaceTasks = projectWorkspaceTasks;

export class PhenixWorkspace implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly submit: (text: string) => Promise<void>;
  private readonly onAction: (action: PhenixWorkspaceAction) => void;
  private readonly editor: CustomEditor;
  private readonly controller: WorkspaceControllerAdapter;
  private readonly transcriptSelection = new TranscriptSelectionSurface();
  focused = true;
  private streamingMessage: AssistantMessage | undefined;
  private disposed = false;
  private renderRevision = 0;
  private frame: RenderFrame | undefined;
  private lastSidebarSection: WorkspaceSection = "runs";

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
      { paddingX: 0, autocompleteMaxVisible: 8 },
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
    this.controller.transcript?.component.invalidate();
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

    const focus = this.effectiveFocus();
    const intent = resolveWorkspaceInput(
      data,
      focus === "main" ? "main" : "sidebar",
      this.transcriptSelection.selection !== undefined,
    );
    switch (intent.kind) {
      case "copy-selection":
        void this.transcriptSelection.copy().catch(() => undefined);
        return;
      case "native-ui":
        this.onAction({ kind: "native", text: this.editor.getText() });
        return;
      case "sidebar-toggle":
        this.controller.dispatch({ type: "sidebar.toggle" });
        if (focus !== "main") this.focusMain();
        return;
      case "focus-toggle":
        this.toggleFocusGroup();
        return;
      case "focus-main":
        this.focusMain();
        return;
      case "transcript-page":
        this.scrollTranscriptPage(intent.direction);
        return;
      case "sidebar-section":
        this.moveSidebarSection(intent.direction);
        return;
      case "sidebar-item":
        this.moveSidebarItem(focus, intent.direction);
        return;
      case "sidebar-edge":
        this.moveSidebarEdge(focus, intent.edge);
        return;
      case "sidebar-activate":
        if (focus !== "main") this.activateSection(focus);
        return;
      case "sidebar-collapse":
        if (focus !== "main") {
          this.controller.dispatch({ type: "section.toggle", paneId: focus });
        }
        return;
      case "editor":
        this.focusMain();
        this.editor.focused = true;
        this.editor.handleInput(data);
    }
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    const dimensions = computeWorkspaceDimensions(
      width,
      height,
      this.controller.state.sidebarVisible,
    );
    if (width < 42 || height < 9) {
      this.frame = undefined;
      return this.renderSmall(width, height);
    }

    const focus = effectiveFocus(this.controller.state.focusedPaneId, dimensions.sidebarVisible);
    this.editor.focused = this.focused && focus === "main";
    const editorLines = this.renderPaneSafely(
      "Editor",
      dimensions.mainWidth,
      Math.max(1, height - 1),
      () =>
        renderWorkspaceComposer({
          lines: this.editor.render(Math.max(1, dimensions.mainWidth - 3)),
          width: dimensions.mainWidth,
          active: focus === "main",
          sidebarVisible: dimensions.sidebarVisible,
          profile: this.controller.snapshot.ui.profile,
          theme: this.theme,
        }),
      false,
    );
    this.renderRevision += 1;
    const solved = solveWorkspaceLayout({
      width,
      height,
      editorHeight: editorLines.length,
      sidebarRequested: this.controller.state.sidebarVisible,
      revision: this.renderRevision,
    });
    if (!solved.ok) {
      this.frame = undefined;
      return this.renderFailure(width, height, "Layout", solved.error.message);
    }

    const layout = solved.value;
    const transcriptBounds = paneRect(layout, "transcript");
    const editorBounds = paneRect(layout, "editor");
    let transcript: TranscriptRender;
    try {
      transcript = this.renderTranscript(transcriptBounds.width, transcriptBounds.height, focus);
    } catch (error) {
      transcript = {
        lines: this.renderPaneError(
          "Transcript",
          transcriptBounds.width,
          transcriptBounds.height,
          error,
        ),
        maxOffset: 0,
        offset: 0,
        plainLines: [],
      };
    }

    this.transcriptSelection.setFrame({
      bounds: transcriptBounds,
      offset: transcript.offset,
      lines: transcript.plainLines,
    });
    const selectedTranscriptLines = transcript.lines.map((line, row) =>
      row === 0
        ? line
        : this.transcriptSelection.renderLine(
            line,
            transcript.offset + row - 1,
            transcriptBounds.width,
            this.theme,
          ),
    );
    const outputs = new Map<PaneId, WorkspacePaneOutput>([
      ["transcript", { lines: selectedTranscriptLines }],
      [
        "editor",
        {
          lines: fitHeight(editorLines, editorBounds.height, editorBounds.width),
        },
      ],
    ]);
    let sections: readonly SectionLayout[] = [];
    const sidebarBounds = layout.panes.get("runs");
    if (sidebarBounds) {
      try {
        const sidebar = this.renderSidebar(sidebarBounds.width, sidebarBounds.height, focus);
        outputs.set("runs", { lines: sidebar.lines });
        sections = sidebar.layouts.map((section) => ({
          ...section,
          start: sidebarBounds.y + section.start,
        }));
      } catch (error) {
        outputs.set("runs", {
          lines: this.renderPaneError("Sidebar", sidebarBounds.width, sidebarBounds.height, error),
        });
      }
    }

    const lines = composeWorkspaceTextFrame(layout, outputs);
    this.frame = {
      layout,
      sections,
      transcriptMaxOffset: transcript.maxOffset,
      transcriptOffset: transcript.offset,
      transcriptLines: transcript.plainLines,
    };
    return [...lines];
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
    const session = transcript?.sessionId ?? selected?.run.pi?.sessionId;
    const copyHint = this.transcriptSelection.selection
      ? ` ${color(this.theme, "muted", "· Ctrl+C copies · Esc edits")}`
      : "";
    const header = surface(
      this.theme,
      focus === "main" ? "selectedBg" : "customMessageBg",
      fitLine(
        ` ${strong(this.theme, title)}${session ? ` ${color(this.theme, "muted", `· ${session}`)}` : ""}${focus === "main" ? ` ${color(this.theme, "muted", "· PgUp/PgDn scroll")}` : ""}${copyHint}`,
        width,
      ),
    );
    const body: string[] = [];
    if (transcript) {
      body.push(...transcript.component.render(width).map((line) => leftOrigin(line, width)));
    } else {
      const unavailable = transcriptAvailabilityMessage(
        this.controller.state.transcript.availability,
      );
      if (unavailable) body.push("", color(this.theme, "warning", ` ${unavailable}`));
    }
    if (selected?.run.kind === "root" && this.streamingMessage) {
      const streaming = new AssistantMessageComponent(
        this.streamingMessage,
        true,
        getMarkdownTheme(),
        "Thinking...",
        1,
      );
      body.push(...streaming.render(width).map((line) => leftOrigin(line, width)));
    }

    const bodyHeight = Math.max(0, height - 1);
    const maxOffset = Math.max(0, body.length - bodyHeight);
    const scroll = this.controller.state.transcript.scroll;
    const offset = scroll.mode === "follow-end" ? maxOffset : clamp(scroll.offset, 0, maxOffset);
    const lines = Array.from({ length: bodyHeight }, (_, row) =>
      leftOrigin(body[offset + row] ?? "", width),
    );
    return {
      lines: [header, ...lines],
      maxOffset,
      offset,
      plainLines: body.map(stripTranscriptAnsi),
    };
  }

  private renderSidebar(width: number, height: number, focus: WorkspaceFocus): SidebarRender {
    const snapshot = this.controller.snapshot;
    const profile = snapshot.ui.profile;
    const diagnostics = snapshot.ui.diagnostics.counts;
    const active = countActive(snapshot.ui.tree.root);
    const header = [
      fitLine(
        ` ${strong(this.theme, "PHENIX")} ${color(this.theme, "muted", `${profile.agent}/${profile.modelSet}/${profile.difficulty}`)}`,
        width,
      ),
      fitLine(
        ` ${state(this.theme, active > 0 ? "running" : "completed", active > 0 ? `${active} active` : "idle")} ${color(this.theme, diagnostics.error > 0 ? "error" : diagnostics.warning > 0 ? "warning" : "success", diagnostics.error > 0 ? `${diagnostics.error} errors` : diagnostics.warning > 0 ? `${diagnostics.warning} warnings` : "healthy")}`,
        width,
      ),
      fitLine(` ${color(this.theme, "muted", "h/l views · j/k rows · ↵ open · space fold")}`, width),
    ];
    const available = Math.max(0, height - header.length);
    const frames = allocateSidebarSections(
      available,
      workspaceViewRegistry.ordered.map((view) => ({
        id: view.id,
        ...view.layout,
        collapsed: this.controller.state.panes[view.id].collapsed,
      })),
    );

    const sections: SectionRender[] = [];
    for (const view of workspaceViewRegistry.ordered) {
      const frame = frames.find((candidate) => candidate.id === view.id);
      const sectionHeight = frame?.height ?? 0;
      if (sectionHeight <= 0) continue;
      try {
        sections.push(this.renderViewSection(view, width, sectionHeight, focus));
      } catch (error) {
        sections.push({
          section: view.id,
          lines: this.renderPaneError(view.title, width, sectionHeight, error),
          offset: 0,
        });
      }
    }

    const layouts: SectionLayout[] = [];
    let start = header.length;
    for (const section of sections) {
      layouts.push({
        section: section.section,
        start,
        height: section.lines.length,
        offset: section.offset,
      });
      start += section.lines.length;
    }
    const lines = fitHeight(
      [...header, ...sections.flatMap((section) => section.lines)],
      height,
      width,
    ).map((line) => surface(this.theme, "customMessageBg", fitLine(line, width)));
    return { lines, layouts };
  }

  private renderViewSection(
    view: WorkspaceViewRegistration,
    width: number,
    height: number,
    focus: WorkspaceFocus,
  ): SectionRender {
    const rows = this.viewRows(view.id);
    const pane = this.controller.state.panes[view.id];
    const selectedIndex = rowIndex(rows, pane.selectedItemId);
    if (height <= 0) return { section: view.id, lines: [], offset: 0 };
    const title = this.sectionHeader(
      view.id,
      `${view.title.toUpperCase()} ${rows.length}`,
      width,
      focus,
    );
    if (pane.collapsed || height === 1) {
      return {
        section: view.id,
        lines: [title, ...blankLines(height - 1, width)],
        offset: 0,
      };
    }
    const bodyHeight = height - 1;
    const offset = keepVisible(scrollOffset(pane.scroll), selectedIndex, bodyHeight, rows.length);
    const body = Array.from({ length: bodyHeight }, (_, row) => {
      const item = rows[offset + row];
      return item ? this.renderViewRow(view.id, item, width, focus) : " ".repeat(width);
    });
    return { section: view.id, lines: [title, ...body], offset };
  }

  private renderViewRow(
    section: WorkspaceSection,
    row: WorkspaceViewRow,
    width: number,
    focus: WorkspaceFocus,
  ): string {
    const selected = row.id === this.controller.state.panes[section].selectedItemId;
    const rendered = row.render({
      theme: this.theme,
      width: Math.max(0, width - 2),
      activeRunId: this.controller.state.activeRunId,
    });
    const cursor = this.focused && focus === section && selected ? CURSOR_MARKER : "";
    const line = fitLine(`${cursor} ${rendered.text}`, width);
    if (selected) {
      return surface(
        this.theme,
        focus === section ? "selectedBg" : "userMessageBg",
        focus === section ? strong(this.theme, line) : line,
      );
    }
    if (rendered.active) return surface(this.theme, "userMessageBg", line);
    return rendered.muted ? color(this.theme, "muted", line) : line;
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

  private scrollTranscriptPage(direction: 1 | -1): void {
    const current = transcriptOffset(
      this.controller.state.transcript.scroll,
      this.frame?.transcriptMaxOffset ?? 0,
    );
    const page = Math.max(
      1,
      (this.frame?.layout.panes.get("transcript")?.height ?? this.tui.terminal.rows) - 3,
    );
    this.setTranscriptOffset(current + direction * page);
  }

  private setTranscriptOffset(value: number): void {
    const maximum = this.frame?.transcriptMaxOffset ?? 0;
    const offset = clamp(value, 0, maximum);
    if (offset >= maximum) {
      this.controller.dispatch({ type: "scroll.end", paneId: "transcript" });
      return;
    }
    this.controller.dispatch({
      type: "scroll.set",
      paneId: "transcript",
      scroll: { mode: "fixed", offset },
    });
  }

  private moveSidebarItem(focus: WorkspaceFocus, direction: 1 | -1): void {
    if (focus === "main") return;
    this.controller.dispatch({
      type: "selection.move",
      paneId: focus,
      direction,
      itemIds: this.sectionItemIds(focus),
    });
  }

  private moveSidebarEdge(focus: WorkspaceFocus, edge: "first" | "last"): void {
    if (focus === "main") return;
    this.controller.dispatch({
      type: "selection.edge",
      paneId: focus,
      edge,
      itemIds: this.sectionItemIds(focus),
    });
  }

  private moveSidebarSection(direction: 1 | -1): void {
    const sections = workspaceViewRegistry.ordered.map((view) => view.id);
    const next = nextWorkspaceSection(this.lastSidebarSection, direction, sections);
    this.focusSidebar(next);
  }

  private activateSection(section: WorkspaceSection): void {
    const selectedItemId = this.controller.state.panes[section].selectedItemId;
    const row = this.viewRows(section).find((candidate) => candidate.id === selectedItemId);
    if (!row?.activation) return;
    if (row.activation.kind === "transcript") {
      const run = findWorkspaceRun(
        this.controller.snapshot.ui.tree.root,
        String(row.activation.runId),
      );
      if (run) this.selectTranscript(run);
      return;
    }
    this.onAction({ kind: "inspector", target: { view: row.activation.view } });
  }

  private selectTranscript(node: RunTreeNode): void {
    this.transcriptSelection.clear();
    this.controller.selectTranscript(node.run.id);
  }

  private toggleFocusGroup(): void {
    const sidebarVisible =
      this.frame?.layout.panes.has("runs") ?? this.controller.state.sidebarVisible;
    if (!sidebarVisible) {
      this.focusMain();
      return;
    }
    if (this.effectiveFocus() === "main") this.focusSidebar(this.lastSidebarSection);
    else this.focusMain();
  }

  private focusMain(): void {
    this.controller.dispatch({ type: "focus.set", paneId: "editor" });
  }

  private focusSidebar(section: WorkspaceSection): void {
    this.lastSidebarSection = section;
    this.controller.dispatch({ type: "focus.set", paneId: section });
  }

  private handleMouse(event: MouseEvent): void {
    if (!this.frame) return;
    if (this.transcriptSelection.dragging) {
      const changed = event.release
        ? this.transcriptSelection.end(event)
        : this.transcriptSelection.update(event);
      if (changed) this.requestRender();
      return;
    }

    if (event.release) return;
    if (event.button === 0 && this.transcriptSelection.begin(event)) {
      this.focusMain();
      this.requestRender();
      return;
    }

    const sidebarBounds = this.frame.layout.panes.get("runs");
    if (!sidebarBounds || event.x <= sidebarBounds.x) {
      this.focusMain();
      if (event.button === 64 || event.button === 65) {
        const current = transcriptOffset(
          this.controller.state.transcript.scroll,
          this.frame.transcriptMaxOffset,
        );
        this.setTranscriptOffset(current + (event.button === 64 ? -3 : 3));
      }
      return;
    }

    this.transcriptSelection.clear();
    const section = this.frame.sections.find(
      (candidate) =>
        candidate.height > 0 &&
        event.y > candidate.start &&
        event.y <= candidate.start + candidate.height,
    );
    if (!section) return;
    this.focusSidebar(section.section);
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

  private viewRows(section: WorkspaceSection): readonly WorkspaceViewRow[] {
    return workspaceViewRegistry.get(section).project(this.controller.snapshot, {
      selectedRunId: this.controller.state.activeRunId,
    });
  }

  private sectionItemIds(section: WorkspaceSection): readonly string[] {
    return this.viewRows(section).map((row) => row.id);
  }

  private effectiveFocus(): WorkspaceFocus {
    return effectiveFocus(
      this.controller.state.focusedPaneId,
      this.frame?.layout.panes.has("runs") ?? false,
    );
  }

  private renderPaneSafely(
    title: string,
    width: number,
    maximumHeight: number,
    render: () => readonly string[],
    exactHeight = true,
  ): string[] {
    try {
      const lines = [...render()];
      return exactHeight ? fitHeight(lines, maximumHeight, width) : lines.slice(0, maximumHeight);
    } catch (error) {
      return this.renderPaneError(title, width, Math.max(1, maximumHeight), error);
    }
  }

  private renderPaneError(title: string, width: number, height: number, error: unknown): string[] {
    const message = error instanceof Error ? error.message : String(error);
    return fitHeight(
      [
        surface(this.theme, "customMessageBg", fitLine(` ${strong(this.theme, title)}`, width)),
        color(this.theme, "error", ` ${truncate(message, Math.max(0, width - 1))}`),
      ],
      height,
      width,
    );
  }

  private renderFailure(width: number, height: number, title: string, message: string): string[] {
    return fitHeight(
      [
        heading(this.theme, ` ${title}`),
        color(this.theme, "error", ` ${truncate(message, Math.max(0, width - 1))}`),
        " Ctrl+O returns to Pi's native UI.",
      ],
      height,
      width,
    );
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

function effectiveFocus(paneId: PaneId, sidebarVisible: boolean): WorkspaceFocus {
  if (sidebarVisible && workspaceViewRegistry.ordered.some((view) => view.id === paneId)) {
    return paneId as WorkspaceViewPaneId;
  }
  return "main";
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

function definitionLabel(value: string): string {
  return value.replace(/^(?:agent|workflow|session|root)\./, "");
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

function rowIndex(rows: readonly WorkspaceViewRow[], selectedItemId: string | undefined): number {
  if (rows.length === 0) return 0;
  const index = selectedItemId ? rows.findIndex((row) => row.id === selectedItemId) : -1;
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
