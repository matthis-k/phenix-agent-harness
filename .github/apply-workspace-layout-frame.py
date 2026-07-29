from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "modules/phenix-pi/extension/phenix-workspace.ts"
text = path.read_text()

text = text.replace(
'''  CombinedAutocompleteProvider,
  type Component,
  matchesKey,
  type SlashCommand,
  sliceByColumn,
  type TUI,
''',
'''  CombinedAutocompleteProvider,
  type Component,
  CURSOR_MARKER,
  type Focusable,
  matchesKey,
  type SlashCommand,
  sliceByColumn,
  type TUI,
''')
text = text.replace(
'''import { allocateSidebarSections } from "../domain/workspace/layout.ts";''',
'''import { allocateSidebarSections, type LayoutFrame } from "../domain/workspace/layout.ts";''')
text = text.replace(
'''import { WorkspaceControllerAdapter } from "./workspace/workspace-controller-adapter.ts";''',
'''import { WorkspaceControllerAdapter } from "./workspace/workspace-controller-adapter.ts";
import {
  composeWorkspaceTextFrame,
  computeWorkspaceDimensions,
  paneRect,
  solveWorkspaceLayout,
  type WorkspaceDimensions,
  type WorkspacePaneOutput,
} from "./workspace/workspace-layout-frame.ts";''')
text = text.replace('const SIDEBAR_MIN_WIDTH = 90;\n', '')
text = text.replace(
'''interface RenderFrame {
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
''',
'''interface RenderFrame {
  readonly layout: LayoutFrame;
  readonly sections: readonly SectionLayout[];
  readonly transcriptMaxOffset: number;
}

export type WorkspaceLayout = WorkspaceDimensions;
export const computeWorkspaceLayout = computeWorkspaceDimensions;
''')
text = text.replace(
'''export class PhenixWorkspace implements Component {''',
'''export class PhenixWorkspace implements Component, Focusable {''')
text = text.replace(
'''  private streamingMessage: AssistantMessage | undefined;
  private disposed = false;
  private frame: RenderFrame = {
    layout: computeWorkspaceLayout(1, 1),
    sections: [],
    transcriptMaxOffset: 0,
  };
''',
'''  focused = true;
  private streamingMessage: AssistantMessage | undefined;
  private disposed = false;
  private renderRevision = 0;
  private frame: RenderFrame | undefined;
''')
old_render = '''  render(width: number): string[] {
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
'''
new_render = '''  render(width: number): string[] {
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

    const focus = effectiveFocus(
      this.controller.state.focusedPaneId,
      dimensions.sidebarVisible,
    );
    this.editor.focused = this.focused && focus === "editor";
    const editorLines = this.renderPaneSafely(
      "Editor",
      dimensions.mainWidth,
      Math.max(1, height - 1),
      () => this.editor.render(dimensions.mainWidth),
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
      transcript = this.renderTranscript(
        transcriptBounds.width,
        transcriptBounds.height,
        focus,
      );
    } catch (error) {
      transcript = {
        lines: this.renderPaneError(
          "Transcript",
          transcriptBounds.width,
          transcriptBounds.height,
          error,
        ),
        maxOffset: 0,
      };
    }

    const outputs = new Map<PaneId, WorkspacePaneOutput>([
      ["transcript", { lines: transcript.lines }],
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
          lines: this.renderPaneError(
            "Sidebar",
            sidebarBounds.width,
            sidebarBounds.height,
            error,
          ),
        });
      }
    }

    const lines = composeWorkspaceTextFrame(layout, outputs);
    this.frame = {
      layout,
      sections,
      transcriptMaxOffset: transcript.maxOffset,
    };
    return [...lines];
  }
'''
assert old_render in text
text = text.replace(old_render, new_render)

text = text.replace(
'''    const line = fitLine(
      ` ${active ? "◆" : " "} ${"  ".repeat(item.depth)}${runStateSymbol(run.state)} ${label} ${run.state}${model}${TERMINAL_STATES.has(run.state) ? "" : activity}`,
      width,
    );''',
'''    const cursor = this.focused && focus === "runs" && selected ? CURSOR_MARKER : "";
    const line = fitLine(
      `${cursor} ${active ? "◆" : " "} ${"  ".repeat(item.depth)}${runStateSymbol(run.state)} ${label} ${run.state}${model}${TERMINAL_STATES.has(run.state) ? "" : activity}`,
      width,
    );''')
text = text.replace(
'''      const line = fitLine(
        ` ${"  ".repeat(item.depth)}${symbol} ${truncate(item.node.title, Math.max(8, width - 5 - item.depth * 2))}`,
        width,
      );''',
'''      const cursor = this.focused && focus === "tasks" && selected ? CURSOR_MARKER : "";
      const line = fitLine(
        `${cursor} ${"  ".repeat(item.depth)}${symbol} ${truncate(item.node.title, Math.max(8, width - 5 - item.depth * 2))}`,
        width,
      );''')
text = text.replace(
'''      const line = fitLine(
        ` ${compactTime(item.timestamp)} ${truncate(item.summary, Math.max(8, width - 8))}`,
        width,
      );''',
'''      const cursor = this.focused && focus === "facts" && selected ? CURSOR_MARKER : "";
      const line = fitLine(
        `${cursor} ${compactTime(item.timestamp)} ${truncate(item.summary, Math.max(8, width - 8))}`,
        width,
      );''')

text = text.replace(
'''      this.frame.transcriptMaxOffset,
''',
'''      this.frame?.transcriptMaxOffset ?? 0,
''')
text = text.replace(
'''      this.setTranscriptOffset(current - Math.max(1, this.frame.layout.height - 4));''',
'''      this.setTranscriptOffset(
        current - Math.max(1, (this.frame?.layout.terminal.height ?? this.tui.terminal.rows) - 4),
      );''')
text = text.replace(
'''      this.setTranscriptOffset(current + Math.max(1, this.frame.layout.height - 4));''',
'''      this.setTranscriptOffset(
        current + Math.max(1, (this.frame?.layout.terminal.height ?? this.tui.terminal.rows) - 4),
      );''')
text = text.replace(
'''    const offset = clamp(value, 0, this.frame.transcriptMaxOffset);
    if (offset >= this.frame.transcriptMaxOffset) {''',
'''    const maximum = this.frame?.transcriptMaxOffset ?? 0;
    const offset = clamp(value, 0, maximum);
    if (offset >= maximum) {''')
text = text.replace(
'''    const order: readonly PaneId[] = this.frame.layout.sidebarVisible
      ? ["transcript", "editor", "runs", "tasks", "facts"]
      : ["transcript", "editor"];''',
'''    const order: readonly PaneId[] = this.frame?.layout.panes.has("runs")
      ? ["transcript", "editor", "runs", "tasks", "facts"]
      : ["transcript", "editor"];''')
old_mouse_start = '''  private handleMouse(event: MouseEvent): void {
    if (event.release) return;
    if (!this.frame.layout.sidebarVisible || event.x <= this.frame.layout.mainWidth) {'''
new_mouse_start = '''  private handleMouse(event: MouseEvent): void {
    if (event.release || !this.frame) return;
    const sidebarBounds = this.frame.layout.panes.get("runs");
    if (!sidebarBounds || event.x <= sidebarBounds.x) {'''
assert old_mouse_start in text
text = text.replace(old_mouse_start, new_mouse_start)
text = text.replace(
'''    return effectiveFocus(this.controller.state.focusedPaneId, this.frame.layout.sidebarVisible);''',
'''    return effectiveFocus(
      this.controller.state.focusedPaneId,
      this.frame?.layout.panes.has("runs") ?? false,
    );''')

insert_before = '''  private renderSmall(width: number, height: number): string[] {'''
helpers = '''  private renderPaneSafely(
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

  private renderPaneError(
    title: string,
    width: number,
    height: number,
    error: unknown,
  ): string[] {
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

'''
assert insert_before in text
text = text.replace(insert_before, helpers + insert_before)

path.write_text(text)
