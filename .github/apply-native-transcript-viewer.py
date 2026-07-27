from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


path = "modules/phenix-pi/extension/phenix-ui.ts"
replace_once(
    path,
    'import { renderCatalogDefinition, renderRunTreeSequence } from "./mermaid-rendering.ts";\n',
    'import { renderCatalogDefinition, renderRunTreeSequence } from "./mermaid-rendering.ts";\nimport type { NativeRunTranscript } from "./native-run-transcript.ts";\n',
)
replace_once(path, 'type UiPane = 0 | 1 | 2;\n', 'type UiPane = 0 | 1 | 2;\ntype RunViewerMode = "diagram" | "transcript";\n')
replace_once(path, '  runs: ["Run tree", "Sequence", "Inspector"],\n', '  runs: ["Run tree", "Diagram", "Inspector"],\n')
replace_once(
    path,
    '''  readonly snapshot: PhenixUiSnapshot;
  readonly load: () => Promise<PhenixUiSnapshot>;
  readonly subscribe: (listener: () => void) => () => void;
''',
    '''  readonly snapshot: PhenixUiSnapshot;
  readonly load: () => Promise<PhenixUiSnapshot>;
  readonly loadTranscript: (node: RunTreeNode) => Promise<NativeRunTranscript>;
  readonly subscribe: (listener: () => void) => () => void;
''',
)
replace_once(
    path,
    '''  private readonly theme: ObservabilityTheme;
  private readonly load: () => Promise<PhenixUiSnapshot>;
  private readonly onClose: () => void;
''',
    '''  private readonly theme: ObservabilityTheme;
  private readonly load: () => Promise<PhenixUiSnapshot>;
  private readonly loadTranscript: (node: RunTreeNode) => Promise<NativeRunTranscript>;
  private readonly onClose: () => void;
''',
)
replace_once(
    path,
    '''  private readonly manuallyExpandedRuns = new Set<string>();
  private runHorizontalOffset = 0;
  private runVerticalOffset = 0;
  private runInspectorOffset = 0;
''',
    '''  private readonly manuallyExpandedRuns = new Set<string>();
  private runViewerMode: RunViewerMode = "diagram";
  private runHorizontalOffset = 0;
  private runVerticalOffset = 0;
  private runTranscriptOffset = Number.MAX_SAFE_INTEGER;
  private runInspectorOffset = 0;
  private readonly transcriptCache = new Map<string, NativeRunTranscript>();
  private readonly transcriptLoading = new Set<string>();
''',
)
replace_once(
    path,
    '''    this.theme = options.theme;
    this.load = options.load;
    this.onClose = options.onClose;
''',
    '''    this.theme = options.theme;
    this.load = options.load;
    this.loadTranscript = options.loadTranscript;
    this.onClose = options.onClose;
''',
)
replace_once(
    path,
    '''  invalidate(): void {
    this.previewCache = undefined;
  }
''',
    '''  invalidate(): void {
    this.previewCache = undefined;
    for (const transcript of this.transcriptCache.values()) transcript.component?.invalidate();
  }
''',
)
replace_once(
    path,
    '''  private renderFocusBar(width: number): string {
    return this.renderSegments(PANE_LABELS[this.view], this.pane, width, false);
  }
''',
    '''  private renderFocusBar(width: number): string {
    return this.renderSegments(this.paneLabels(), this.pane, width, false);
  }

  private paneLabels(): readonly string[] {
    if (this.view === "runs") return ["Run tree", capitalize(this.runViewerMode), "Inspector"];
    return PANE_LABELS[this.view];
  }
''',
)
replace_once(path, 'PANE_LABELS[this.view][this.pane]', 'this.paneLabels()[this.pane]')
replace_once(
    path,
    '''    const paneHint = this.paneCount() > 1 ? " · Tab pane" : "";
    return `1-4 views${paneHint} · / filter · arrows/hjkl navigate · ? help · r refresh · Esc close`;
''',
    '''    const paneHint = this.paneCount() > 1 ? " · Tab pane" : "";
    const viewerHint = this.view === "runs" ? " · v diagram/transcript" : "";
    return `1-4 views${paneHint}${viewerHint} · / filter · arrows/hjkl navigate · ? help · r refresh · Esc close`;
''',
)
replace_once(path, 'this.renderRunPreviewPane(selected, width, height)', 'this.renderRunViewerPane(selected, width, height)')
replace_once(path, 'this.renderRunPreviewPane(selected, previewWidth, height)', 'this.renderRunViewerPane(selected, previewWidth, height)')
replace_once(
    path,
    '''      const left = this.panelLine(tree[row] ?? "", treeWidth, 0);
      const middle = this.panelLine(preview[row] ?? "", previewWidth, 1);
      if (inspectorWidth === 0) return `${left} ${middle}`;
''',
    '''      const left = this.panelLine(tree[row] ?? "", treeWidth, 0);
      const middle =
        this.runViewerMode === "transcript"
          ? this.fitLine(preview[row] ?? "", previewWidth)
          : this.panelLine(preview[row] ?? "", previewWidth, 1);
      if (inspectorWidth === 0) return `${left} ${middle}`;
''',
)
replace_once(
    path,
    '''  private renderRunPreviewPane(node: RunTreeNode, width: number, height: number): string[] {
    const lines = this.runPreviewLines(node);
    const longest = maxVisibleWidth(lines);
    const maxX = Math.max(0, longest - width);
    const maxY = Math.max(0, lines.length - height);
    this.runHorizontalOffset = clamp(this.runHorizontalOffset, 0, maxX);
    this.runVerticalOffset = clamp(this.runVerticalOffset, 0, maxY);
    return Array.from({ length: height }, (_, row) => {
      const source = lines[this.runVerticalOffset + row] ?? "";
      return this.fitLine(sliceByColumn(source, this.runHorizontalOffset, width, true), width);
    });
  }
''',
    '''  private renderRunViewerPane(node: RunTreeNode, width: number, height: number): string[] {
    return this.runViewerMode === "diagram"
      ? this.renderRunDiagramPane(node, width, height)
      : this.renderRunTranscriptPane(node, width, height);
  }

  private renderRunDiagramPane(node: RunTreeNode, width: number, height: number): string[] {
    const lines = this.runPreviewLines(node);
    const longest = maxVisibleWidth(lines);
    const maxX = Math.max(0, longest - width);
    const maxY = Math.max(0, lines.length - height);
    this.runHorizontalOffset = clamp(this.runHorizontalOffset, 0, maxX);
    this.runVerticalOffset = clamp(this.runVerticalOffset, 0, maxY);
    return Array.from({ length: height }, (_, row) => {
      const source = lines[this.runVerticalOffset + row] ?? "";
      return this.fitLine(sliceByColumn(source, this.runHorizontalOffset, width, true), width);
    });
  }

  private renderRunTranscriptPane(node: RunTreeNode, width: number, height: number): string[] {
    const key = String(node.run.id);
    const transcript = this.transcriptCache.get(key);
    const sessionId = transcript?.sessionId ?? node.run.pi?.sessionId;
    const lines: string[] = [
      heading(this.theme, " Transcript"),
      color(
        this.theme,
        "muted",
        ` ${definitionLabel(String(node.run.definitionId))}${sessionId ? ` · ${sessionId}` : ""}`,
      ),
      "",
    ];
    if (this.transcriptLoading.has(key) && !transcript) {
      lines.push(color(this.theme, "muted", " Loading Pi transcript…"));
    } else if (!transcript) {
      lines.push(color(this.theme, "muted", " Press v or Enter to load this Pi session."));
    } else if (transcript.unavailable) {
      lines.push(color(this.theme, "warning", ` ${transcript.unavailable}`));
    } else if (transcript.component) {
      lines.push(...transcript.component.render(width));
    }
    const maxY = Math.max(0, lines.length - height);
    this.runTranscriptOffset = clamp(this.runTranscriptOffset, 0, maxY);
    return Array.from({ length: height }, (_, row) =>
      this.fitLine(lines[this.runTranscriptOffset + row] ?? "", width),
    );
  }
''',
)
replace_once(
    path,
    '''      statusField("requested", compactTimestamp(run.requestedAt)),
      statusField(
        "model",
''',
    '''      statusField("requested", compactTimestamp(run.requestedAt)),
      statusField("session", run.pi?.sessionId ?? "none"),
      statusField("transcript", run.pi?.sessionFile ? "persisted" : "none"),
      statusField(
        "model",
''',
)
replace_once(
    path,
    '''      "Enter               drill into selected item",
      "Space               expand or collapse a run",
''',
    '''      "Enter               open the selected run or session",
      "v                   toggle run diagram/transcript",
      "Space               expand or collapse a run",
''',
)
replace_once(
    path,
    '''    const selected = flat[index];
    if (this.pane === 0) {
''',
    '''    const selected = flat[index];
    if ((data === "v" || data === "V") && selected) {
      this.toggleRunViewer(selected.node);
      return;
    }
    if (this.pane === 0) {
''',
)
replace_once(
    path,
    '''      else if (data === " " && selected) this.toggleRun(selected.node);
      else if (matchesKey(data, "right") || matchesKey(data, "enter")) {
        if (
          selected?.node.children.length &&
          this.collapsedRuns.has(String(selected.node.run.id))
        ) {
          this.collapsedRuns.delete(String(selected.node.run.id));
        } else this.pane = 1;
      } else if (matchesKey(data, "left") && selected) {
''',
    '''      else if (data === " " && selected) this.toggleRun(selected.node);
      else if (matchesKey(data, "enter") && selected) {
        if (
          selected.node.children.length &&
          this.collapsedRuns.has(String(selected.node.run.id))
        ) {
          this.collapsedRuns.delete(String(selected.node.run.id));
        } else {
          this.runViewerMode = selected.node.run.pi?.sessionFile ? "transcript" : "diagram";
          this.pane = 1;
          if (this.runViewerMode === "transcript") void this.ensureRunTranscript(selected.node);
        }
      } else if (matchesKey(data, "right")) {
        if (
          selected?.node.children.length &&
          this.collapsedRuns.has(String(selected.node.run.id))
        ) {
          this.collapsedRuns.delete(String(selected.node.run.id));
        } else this.pane = 1;
      } else if (matchesKey(data, "left") && selected) {
''',
)
replace_once(
    path,
    '''    if (this.pane === 1) {
      if (isLeft(data)) this.runHorizontalOffset = Math.max(0, this.runHorizontalOffset - 4);
      else if (isRight(data)) this.runHorizontalOffset += 4;
      else if (isUp(data)) this.runVerticalOffset = Math.max(0, this.runVerticalOffset - 1);
      else if (isDown(data)) this.runVerticalOffset += 1;
      else if (matchesKey(data, "pageUp"))
        this.runVerticalOffset = Math.max(0, this.runVerticalOffset - this.layout.bodyHeight + 2);
      else if (matchesKey(data, "pageDown")) this.runVerticalOffset += this.layout.bodyHeight - 2;
      else if (matchesKey(data, "home")) this.runHorizontalOffset = 0;
      else if (matchesKey(data, "end")) this.runHorizontalOffset = Number.MAX_SAFE_INTEGER;
      else return;
      this.requestRender();
      return;
    }
''',
    '''    if (this.pane === 1) {
      if (this.runViewerMode === "transcript") {
        if (isUp(data)) this.runTranscriptOffset = Math.max(0, this.runTranscriptOffset - 1);
        else if (isDown(data)) this.runTranscriptOffset += 1;
        else if (matchesKey(data, "pageUp"))
          this.runTranscriptOffset = Math.max(
            0,
            this.runTranscriptOffset - this.layout.bodyHeight + 2,
          );
        else if (matchesKey(data, "pageDown"))
          this.runTranscriptOffset += this.layout.bodyHeight - 2;
        else if (matchesKey(data, "home")) this.runTranscriptOffset = 0;
        else if (matchesKey(data, "end")) this.runTranscriptOffset = Number.MAX_SAFE_INTEGER;
        else return;
      } else if (isLeft(data)) this.runHorizontalOffset = Math.max(0, this.runHorizontalOffset - 4);
      else if (isRight(data)) this.runHorizontalOffset += 4;
      else if (isUp(data)) this.runVerticalOffset = Math.max(0, this.runVerticalOffset - 1);
      else if (isDown(data)) this.runVerticalOffset += 1;
      else if (matchesKey(data, "pageUp"))
        this.runVerticalOffset = Math.max(0, this.runVerticalOffset - this.layout.bodyHeight + 2);
      else if (matchesKey(data, "pageDown")) this.runVerticalOffset += this.layout.bodyHeight - 2;
      else if (matchesKey(data, "home")) this.runHorizontalOffset = 0;
      else if (matchesKey(data, "end")) this.runHorizontalOffset = Number.MAX_SAFE_INTEGER;
      else return;
      this.requestRender();
      return;
    }
''',
)
replace_once(
    path,
    '''    if (target.kind === "run") {
      this.selectRun(target.item.node);
      this.switchView("runs");
      return;
    }
''',
    '''    if (target.kind === "run") {
      this.selectRun(target.item.node);
      this.runViewerMode = target.item.node.run.pi?.sessionFile ? "transcript" : "diagram";
      this.pane = 1;
      if (this.runViewerMode === "transcript") void this.ensureRunTranscript(target.item.node);
      this.switchView("runs");
      return;
    }
''',
)
replace_once(
    path,
    '''  private selectRun(node: RunTreeNode): void {
    this.selectedRunId = String(node.run.id);
    this.runHorizontalOffset = 0;
    this.runVerticalOffset = 0;
    this.runInspectorOffset = 0;
    this.previewCache = undefined;
  }
''',
    '''  private selectRun(node: RunTreeNode): void {
    this.selectedRunId = String(node.run.id);
    this.runHorizontalOffset = 0;
    this.runVerticalOffset = 0;
    this.runTranscriptOffset = Number.MAX_SAFE_INTEGER;
    this.runInspectorOffset = 0;
    this.previewCache = undefined;
  }

  private toggleRunViewer(node: RunTreeNode): void {
    this.runViewerMode = this.runViewerMode === "diagram" ? "transcript" : "diagram";
    this.runHorizontalOffset = 0;
    this.runVerticalOffset = 0;
    this.runTranscriptOffset = Number.MAX_SAFE_INTEGER;
    if (this.runViewerMode === "transcript") void this.ensureRunTranscript(node);
    this.requestRender();
  }

  private async ensureRunTranscript(node: RunTreeNode, reload = false): Promise<void> {
    const key = String(node.run.id);
    if ((!reload && this.transcriptCache.has(key)) || this.transcriptLoading.has(key)) return;
    this.transcriptLoading.add(key);
    this.requestRender();
    try {
      const transcript = await this.loadTranscript(node);
      if (this.disposed) return;
      this.transcriptCache.set(key, transcript);
      if (this.selectedRunId === key) this.runTranscriptOffset = Number.MAX_SAFE_INTEGER;
    } catch (error) {
      this.transcriptCache.set(key, {
        sessionId: node.run.pi?.sessionId,
        sessionFile: node.run.pi?.sessionFile,
        unavailable: `Unable to load Pi transcript: ${errorMessage(error)}`,
      });
    } finally {
      this.transcriptLoading.delete(key);
      this.requestRender();
    }
  }
''',
)
replace_once(
    path,
    '''        this.snapshot = snapshot;
        this.initializeCollapsedRuns(snapshot.tree.root);
        this.previewCache = undefined;
        this.requestRender();
''',
    '''        this.snapshot = snapshot;
        this.initializeCollapsedRuns(snapshot.tree.root);
        this.previewCache = undefined;
        if (this.view === "runs" && this.runViewerMode === "transcript") {
          const selected = flattenRuns(snapshot.tree.root, new Set()).find(
            (item) => String(item.node.run.id) === this.selectedRunId,
          );
          if (selected) void this.ensureRunTranscript(selected.node, true);
        }
        this.requestRender();
''',
)

path = "modules/phenix-pi/extension/root-extension.ts"
replace_once(
    path,
    'import { renderTerminalMermaid } from "./mermaid-rendering.ts";\n',
    'import { renderTerminalMermaid } from "./mermaid-rendering.ts";\nimport { loadNativeRunTranscript } from "./native-run-transcript.ts";\n',
)
replace_once(
    path,
    '''        snapshot,
        load,
        subscribe: (listener) => {
''',
    '''        snapshot,
        load,
        loadTranscript: (node) => loadNativeRunTranscript(node, tui),
        subscribe: (listener) => {
''',
)

path = "modules/phenix-pi/tests/phenix-ui.test.ts"
replace_once(
    path,
    'import type { TUI } from "@earendil-works/pi-tui";\nimport { visibleWidth } from "@earendil-works/pi-tui";\n',
    'import type { TUI } from "@earendil-works/pi-tui";\nimport { Container, Text, visibleWidth } from "@earendil-works/pi-tui";\n',
)
replace_once(
    path,
    '''test("uses centered background surfaces without redundant active markers", () => {
''',
    '''test("opens a selected agent with Pi-native transcript rendering and toggles its diagram", async () => {
  const ui = createUi(fakeTui(20), { view: "runs", selector: "run-child" });

  ui.handleInput("\\r");
  await new Promise((resolve) => setImmediate(resolve));
  let output = ui.render(140).join("\\n");
  assert.match(output, /Transcript/);
  assert.match(output, /Pi native transcript for session-child/);
  assert.match(output, /session: session-child/);

  ui.handleInput("v");
  output = ui.render(140).join("\\n");
  assert.match(output, /Diagram/);
  assert.doesNotMatch(output, /Pi native transcript for session-child/);
});

test("Status opens an active agent directly in its native transcript", async () => {
  const ui = createUi(fakeTui(20), { view: "status" });

  ui.handleInput("\\r");
  await new Promise((resolve) => setImmediate(resolve));
  const output = ui.render(120).join("\\n");
  assert.match(output, /Phenix · Runs/);
  assert.match(output, /Transcript/);
  assert.match(output, /Pi native transcript for session-child/);
});

test("uses centered background surfaces without redundant active markers", () => {
''',
)
replace_once(
    path,
    '''    snapshot,
    load: async () => snapshot,
    subscribe: () => () => undefined,
''',
    '''    snapshot,
    load: async () => snapshot,
    loadTranscript: async (node) => {
      const component = new Container();
      component.addChild(new Text(`Pi native transcript for ${node.run.pi?.sessionId ?? "none"}`, 0, 0));
      return {
        component,
        sessionId: node.run.pi?.sessionId,
        sessionFile: node.run.pi?.sessionFile,
      };
    },
    subscribe: () => () => undefined,
''',
)
replace_once(
    path,
    '''            state: "running",
            revision: 1,
            compiled: {
''',
    '''            state: "running",
            revision: 1,
            pi: {
              sessionId: "session-child",
              sessionFile: "/tmp/session-child.jsonl",
            },
            compiled: {
''',
)
