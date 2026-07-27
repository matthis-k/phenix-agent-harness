from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:100]!r}")
    target.write_text(text.replace(old, new, 1))


# Run monitor: keep the existing optional vertical widget, and add an independent
# automatically managed chat sidebar.
path = "modules/phenix-pi/extension/run-monitor.ts"
replace_once(
    path,
    'import { renderRunTreeSequence } from "./mermaid-rendering.ts";\n',
    'import { renderRunTreeSequence } from "./mermaid-rendering.ts";\nimport {\n  createPhenixSidebarWidget,\n  shouldShowPhenixSidebar,\n} from "./phenix-sidebar.ts";\n',
)
replace_once(
    path,
    'const WIDGET_KEY = "phenix-live-status";\n',
    'const WIDGET_KEY = "phenix-live-status";\nconst SIDEBAR_WIDGET_KEY = "phenix-sidebar";\n',
)
replace_once(
    path,
    '  private pending = false;\n  private disposed = false;\n',
    '  private pending = false;\n  private sidebarRefreshing = false;\n  private sidebarPending = false;\n  private disposed = false;\n',
)
replace_once(
    path,
    '''  hide(): void {
    this.mode = "hidden";
    this.ctx.ui.setWidget?.(WIDGET_KEY, undefined);
  }

  async refresh(): Promise<void> {
''',
    '''  hide(): void {
    this.mode = "hidden";
    this.ctx.ui.setWidget?.(WIDGET_KEY, undefined);
  }

  async syncSidebar(): Promise<void> {
    if (this.disposed) return;
    if (this.sidebarRefreshing) {
      this.sidebarPending = true;
      return;
    }
    this.sidebarRefreshing = true;
    try {
      do {
        this.sidebarPending = false;
        const data = await this.dashboardData();
        if (this.disposed) return;
        if (!shouldShowPhenixSidebar(data, this.ctx.model?.provider === "phenix")) {
          this.ctx.ui.setWidget?.(SIDEBAR_WIDGET_KEY, undefined);
          continue;
        }
        this.ctx.ui.setWidget?.(SIDEBAR_WIDGET_KEY, createPhenixSidebarWidget(data), {
          placement: "sidebar",
          width: 36,
        });
      } while (this.sidebarPending && !this.disposed);
    } finally {
      this.sidebarRefreshing = false;
    }
  }

  async refresh(): Promise<void> {
''',
)
replace_once(
    path,
    '''  dispose(): void {
    this.disposed = true;
    this.hide();
  }
''',
    '''  dispose(): void {
    this.disposed = true;
    this.hide();
    this.ctx.ui.setWidget?.(SIDEBAR_WIDGET_KEY, undefined);
  }
''',
)

# Root extension: synchronize the default sidebar with runtime/profile/model
# changes, and pass the transcript loader to the full-screen UI.
path = "modules/phenix-pi/extension/root-extension.ts"
replace_once(
    path,
    'import { RunMonitor } from "./run-monitor.ts";\n',
    'import { RunMonitor } from "./run-monitor.ts";\nimport { loadRunTranscript } from "./run-transcript.ts";\n',
)
replace_once(
    path,
    '''    const refresh = (): void => {
      void updateStatus(ctx, currentRuntime, currentRoot);
    };
''',
    '''    const refresh = (): void => {
      void updateStatus(ctx, currentRuntime, currentRoot);
      void monitor?.syncSidebar();
    };
''',
)
replace_once(
    path,
    '''    await applyAgentTools(pi, ctx, (await currentRuntime.profiles.current(currentRoot)).agent);
    await updateStatus(ctx, currentRuntime, currentRoot);
    appendBinding(pi, currentRuntime, currentRoot, sessionId);
''',
    '''    await applyAgentTools(pi, ctx, (await currentRuntime.profiles.current(currentRoot)).agent);
    await Promise.all([
      updateStatus(ctx, currentRuntime, currentRoot),
      monitor.syncSidebar(),
    ]);
    appendBinding(pi, currentRuntime, currentRoot, sessionId);
''',
)
replace_once(
    path,
    '''      await runtime.profiles.select(rootRunId, {
        modelSet: event.model.id,
        source: "model-select",
      });
      return;
    }
    await runtime.observeRootModel(rootRunId, concreteModel(event.model.provider, event.model.id));
''',
    '''      await runtime.profiles.select(rootRunId, {
        modelSet: event.model.id,
        source: "model-select",
      });
      await monitor?.syncSidebar();
      return;
    }
    await runtime.observeRootModel(rootRunId, concreteModel(event.model.provider, event.model.id));
    await monitor?.syncSidebar();
''',
)
replace_once(
    path,
    '''      await applyAgentTools(pi, ctx, profile.agent);
      await updateStatus(ctx, active.runtime, active.root);
    },
  });

  pi.registerCommand("modelset", {
''',
    '''      await applyAgentTools(pi, ctx, profile.agent);
      await Promise.all([
        updateStatus(ctx, active.runtime, active.root),
        monitor?.syncSidebar(),
      ]);
    },
  });

  pi.registerCommand("modelset", {
''',
)
replace_once(
    path,
    '''      await active.runtime.profiles.select(active.root, {
        modelSet: selected,
        source: "user",
      });
      await updateStatus(ctx, active.runtime, active.root);
    },
  });

  pi.registerCommand("difficulty", {
''',
    '''      await active.runtime.profiles.select(active.root, {
        modelSet: selected,
        source: "user",
      });
      await Promise.all([
        updateStatus(ctx, active.runtime, active.root),
        monitor?.syncSidebar(),
      ]);
    },
  });

  pi.registerCommand("difficulty", {
''',
)
replace_once(
    path,
    '''      pi.setThinkingLevel(thinkingForDifficulty(selected));
      await updateStatus(ctx, active.runtime, active.root);
    },
  });
''',
    '''      pi.setThinkingLevel(thinkingForDifficulty(selected));
      await Promise.all([
        updateStatus(ctx, active.runtime, active.root),
        monitor?.syncSidebar(),
      ]);
    },
  });
''',
)
replace_once(
    path,
    '''        load,
        subscribe: (listener) => {
''',
    '''        load,
        loadTranscript: loadRunTranscript,
        subscribe: (listener) => {
''',
)

# Full-screen UI: selected run/session viewer with diagram/transcript modes.
path = "modules/phenix-pi/extension/phenix-ui.ts"
replace_once(
    path,
    'import { renderCatalogDefinition, renderRunTreeSequence } from "./mermaid-rendering.ts";\n',
    'import { renderCatalogDefinition, renderRunTreeSequence } from "./mermaid-rendering.ts";\nimport type { RunTranscript, TranscriptEntry } from "./run-transcript.ts";\n',
)
replace_once(
    path,
    'type UiPane = 0 | 1 | 2;\n',
    'type UiPane = 0 | 1 | 2;\ntype RunViewerMode = "diagram" | "transcript";\n',
)
replace_once(
    path,
    '  runs: ["Run tree", "Sequence", "Inspector"],\n',
    '  runs: ["Run tree", "Diagram", "Inspector"],\n',
)
replace_once(
    path,
    '''  readonly snapshot: PhenixUiSnapshot;
  readonly load: () => Promise<PhenixUiSnapshot>;
  readonly subscribe: (listener: () => void) => () => void;
''',
    '''  readonly snapshot: PhenixUiSnapshot;
  readonly load: () => Promise<PhenixUiSnapshot>;
  readonly loadTranscript: (node: RunTreeNode) => Promise<RunTranscript>;
  readonly subscribe: (listener: () => void) => () => void;
''',
)
replace_once(
    path,
    '''  private readonly load: () => Promise<PhenixUiSnapshot>;
  private readonly onClose: () => void;
''',
    '''  private readonly load: () => Promise<PhenixUiSnapshot>;
  private readonly loadTranscript: (node: RunTreeNode) => Promise<RunTranscript>;
  private readonly onClose: () => void;
''',
)
replace_once(
    path,
    '''  private runHorizontalOffset = 0;
  private runVerticalOffset = 0;
  private runInspectorOffset = 0;
''',
    '''  private runViewerMode: RunViewerMode = "diagram";
  private runHorizontalOffset = 0;
  private runVerticalOffset = 0;
  private runTranscriptOffset = Number.MAX_SAFE_INTEGER;
  private runInspectorOffset = 0;
  private readonly transcriptCache = new Map<string, RunTranscript>();
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
    '''  private renderFocusBar(width: number): string {
    return this.renderSegments(PANE_LABELS[this.view], this.pane, width, false);
  }
''',
    '''  private renderFocusBar(width: number): string {
    return this.renderSegments(this.paneLabels(), this.pane, width, false);
  }

  private paneLabels(): readonly string[] {
    if (this.view === "runs") {
      return ["Run tree", capitalize(this.runViewerMode), "Inspector"];
    }
    return PANE_LABELS[this.view];
  }
''',
)
replace_once(
    path,
    '    const paneLabel = PANE_LABELS[this.view][this.pane] ?? `pane ${this.pane + 1}`;\n',
    '    const paneLabel = this.paneLabels()[this.pane] ?? `pane ${this.pane + 1}`;\n',
)
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
replace_once(path, 'this.renderRunPreviewPane(selected, width, height)', 'this.renderRunViewerPane(selected, width, height)')
replace_once(path, 'this.renderRunPreviewPane(selected, previewWidth, height)', 'this.renderRunViewerPane(selected, previewWidth, height)')
old_preview = '''  private renderRunPreviewPane(node: RunTreeNode, width: number, height: number): string[] {
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
'''
new_preview = '''  private renderRunViewerPane(node: RunTreeNode, width: number, height: number): string[] {
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
    const lines = this.transcriptLines(node, transcript, width);
    const maxY = Math.max(0, lines.length - height);
    this.runTranscriptOffset = clamp(this.runTranscriptOffset, 0, maxY);
    return Array.from({ length: height }, (_, row) =>
      this.fitLine(lines[this.runTranscriptOffset + row] ?? "", width),
    );
  }

  private transcriptLines(
    node: RunTreeNode,
    transcript: RunTranscript | undefined,
    width: number,
  ): readonly string[] {
    const key = String(node.run.id);
    const sessionId = node.run.pi?.sessionId;
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
      lines.push(color(this.theme, "muted", " Loading transcript…"));
      return lines;
    }
    if (!transcript) {
      lines.push(color(this.theme, "muted", " Press v or Enter to load this session transcript."));
      return lines;
    }
    if (transcript.unavailable) {
      lines.push(color(this.theme, "warning", ` ${transcript.unavailable}`));
      return lines;
    }
    if (transcript.truncated) {
      lines.push(color(this.theme, "dim", " Earlier transcript entries omitted."), "");
    }
    if (transcript.entries.length === 0) {
      lines.push(color(this.theme, "muted", " No transcript messages recorded yet."));
      return lines;
    }
    for (const entry of transcript.entries) {
      lines.push(...renderTranscriptEntry(this.theme, entry, width));
    }
    return lines;
  }
'''
replace_once(path, old_preview, new_preview)
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
old_runs_input = '''    const selected = flat[index];
    if (this.pane === 0) {
      if (isUp(data)) index -= 1;
      else if (isDown(data)) index += 1;
      else if (matchesKey(data, "home")) index = 0;
      else if (matchesKey(data, "end")) index = flat.length - 1;
      else if (data === " " && selected) this.toggleRun(selected.node);
      else if (matchesKey(data, "right") || matchesKey(data, "enter")) {
        if (
          selected?.node.children.length &&
          this.collapsedRuns.has(String(selected.node.run.id))
        ) {
          this.collapsedRuns.delete(String(selected.node.run.id));
        } else this.pane = 1;
      } else if (matchesKey(data, "left") && selected) {
'''
new_runs_input = '''    const selected = flat[index];
    if ((data === "v" || data === "V") && selected) {
      this.toggleRunViewer(selected.node);
      return;
    }
    if (this.pane === 0) {
      if (isUp(data)) index -= 1;
      else if (isDown(data)) index += 1;
      else if (matchesKey(data, "home")) index = 0;
      else if (matchesKey(data, "end")) index = flat.length - 1;
      else if (data === " " && selected) this.toggleRun(selected.node);
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
'''
replace_once(path, old_runs_input, new_runs_input)
old_pane_one = '''    if (this.pane === 1) {
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
'''
new_pane_one = '''    if (this.pane === 1) {
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
'''
replace_once(path, old_pane_one, new_pane_one)
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
        entries: [],
        truncated: false,
        unavailable: `Unable to load transcript: ${errorMessage(error)}`,
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
# Add transcript rendering helpers before formatFactLine.
replace_once(
    path,
    '''function formatFactLine(theme: ObservabilityTheme, item: RunFact): string {
''',
    '''function renderTranscriptEntry(
  theme: ObservabilityTheme,
  entry: TranscriptEntry,
  width: number,
): readonly string[] {
  const label =
    entry.role === "user"
      ? color(theme, "accent", "user")
      : entry.role === "assistant"
        ? color(theme, "success", "assistant")
        : entry.role === "tool"
          ? color(theme, entry.error ? "error" : "warning", entry.error ? "tool error" : "tool")
          : color(theme, entry.error ? "error" : "muted", "system");
  const timestamp = entry.timestamp ? ` ${color(theme, "dim", compactTimestamp(entry.timestamp))}` : "";
  const lines = [` ${label}${timestamp}`];
  for (const paragraph of entry.text.split("\\n")) {
    for (const line of wrapText(paragraph, Math.max(8, width - 3))) {
      lines.push(`   ${color(theme, "text", line)}`);
    }
  }
  lines.push("");
  return lines;
}

function wrapText(text: string, width: number): readonly string[] {
  const normalized = text.replace(/\\t/g, "  ").trimEnd();
  if (!normalized) return [""];
  const lines: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    if (visibleWidth(remaining) <= width) {
      lines.push(remaining);
      break;
    }
    let cut = Math.min(remaining.length, width);
    while (cut > 1 && visibleWidth(remaining.slice(0, cut)) > width) cut -= 1;
    const whitespace = remaining.slice(0, cut + 1).lastIndexOf(" ");
    if (whitespace > Math.floor(width * 0.45)) cut = whitespace;
    lines.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  return lines;
}

function formatFactLine(theme: ObservabilityTheme, item: RunFact): string {
''',
)

# UI tests: a persisted child session, deterministic transcript loader, and
# keyboard/status paths into the transcript viewer.
path = "modules/phenix-pi/tests/phenix-ui.test.ts"
replace_once(
    path,
    'import type { ObservabilityTheme } from "../extension/observability-theme.ts";\n',
    'import type { ObservabilityTheme } from "../extension/observability-theme.ts";\nimport type { RunTranscript } from "../extension/run-transcript.ts";\n',
)
replace_once(
    path,
    '''test("uses centered background surfaces without redundant active markers", () => {
''',
    '''test("opens the selected agent session transcript and toggles to its diagram", async () => {
  const ui = createUi(fakeTui(20), { view: "runs", selector: "run-child" });

  ui.handleInput("\\r");
  await new Promise((resolve) => setImmediate(resolve));
  let output = ui.render(140).join("\\n");
  assert.match(output, /Transcript/);
  assert.match(output, /session-child/);
  assert.match(output, /Inspect the workflow definitions/);
  assert.match(output, /session: session-child/);

  ui.handleInput("v");
  output = ui.render(140).join("\\n");
  assert.match(output, /Diagram/);
  assert.doesNotMatch(output, /Inspect the workflow definitions/);
});

test("Status opens an active agent directly in its transcript", async () => {
  const ui = createUi(fakeTui(20), { view: "status" });

  ui.handleInput("\\r");
  await new Promise((resolve) => setImmediate(resolve));
  const output = ui.render(120).join("\\n");
  assert.match(output, /Phenix · Runs/);
  assert.match(output, /Transcript/);
  assert.match(output, /Inspect the workflow definitions/);
});

test("uses centered background surfaces without redundant active markers", () => {
''',
)
replace_once(
    path,
    '''    load: async () => snapshot,
    subscribe: () => () => undefined,
''',
    '''    load: async () => snapshot,
    loadTranscript: async (node) => transcriptFor(String(node.run.id)),
    subscribe: () => () => undefined,
''',
)
replace_once(
    path,
    '''            revision: 1,
            compiled: {
''',
    '''            revision: 1,
            pi: {
              sessionId: "session-child",
              sessionFile: "/tmp/session-child.jsonl",
            },
            compiled: {
''',
)
replace_once(
    path,
    '''function fixtureSnapshot(): PhenixUiSnapshot {
''',
    '''function transcriptFor(run: string): RunTranscript {
  if (run !== "run-child") {
    return {
      entries: [],
      truncated: false,
      unavailable: "No Pi transcript for this run.",
    };
  }
  return {
    sessionId: "session-child",
    sessionFile: "/tmp/session-child.jsonl",
    truncated: false,
    entries: [
      {
        role: "user",
        text: "Inspect the workflow definitions",
        timestamp: "2026-07-26T10:00:01.000Z",
      },
      {
        role: "assistant",
        text: "I am reviewing the workflow graph.",
        timestamp: "2026-07-26T10:00:02.000Z",
      },
    ],
  };
}

function fixtureSnapshot(): PhenixUiSnapshot {
''',
)

# Sidebar rendering tests.
path = "modules/phenix-pi/tests/run-monitor.test.ts"
replace_once(
    path,
    'import { createUnboundedWidget, renderDashboard } from "../extension/run-monitor.ts";\n',
    'import { renderPhenixSidebar, shouldShowPhenixSidebar } from "../extension/phenix-sidebar.ts";\nimport { createUnboundedWidget, renderDashboard } from "../extension/run-monitor.ts";\n',
)
replace_once(
    path,
    '''test("widget component factory bypasses Pi's string-array line cap", () => {
''',
    '''test("compact sidebar shows the live run tree and activates only for Phenix context", () => {
  const child = snapshot(runId("run-sidebar-agent"), ROOT, "agent.scout");
  const data = {
    tree: {
      root: {
        run: snapshot(ROOT, undefined, "root.session"),
        children: [{ run: child, children: [] }],
      },
    },
    sequence: 7,
    profile: { agent: "base" as const, modelSet: "mixed" as const, difficulty: "D1" as const },
    diagnostics: DIAGNOSTICS,
  };

  assert.equal(shouldShowPhenixSidebar(data, false), true);
  assert.match(renderPhenixSidebar(data).join("\\n"), /Run tree/);
  assert.match(renderPhenixSidebar(data).join("\\n"), /scout running/);
  assert.equal(
    shouldShowPhenixSidebar(
      {
        ...data,
        tree: { root: { run: data.tree.root.run, children: [] } },
      },
      false,
    ),
    false,
  );
  assert.equal(
    shouldShowPhenixSidebar(
      {
        ...data,
        tree: { root: { run: data.tree.root.run, children: [] } },
      },
      true,
    ),
    true,
  );
});

test("widget component factory bypasses Pi's string-array line cap", () => {
''',
)
