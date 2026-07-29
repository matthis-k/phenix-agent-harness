import {
  type Component,
  Container,
  matchesKey,
  Text,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { RunTree, RunTreeNode } from "../application/interfaces.ts";
import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import { type AnyDefinition, definitionRef } from "../domain/definition/definition.ts";
import type { DiagnosticSummary } from "../domain/diagnostics.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import type { RunFact } from "../domain/run/observability.ts";
import type { RunId } from "../domain/shared.ts";
import {
  fitViewLine,
  ListView,
  renderPanel,
  TerminalView,
  TreeView,
  type TreeViewEvent,
} from "./components/index.ts";
import { renderCatalogDefinition, renderRunTreeSequence } from "./mermaid-rendering.ts";
import type { NativeRunTranscript } from "./native-run-transcript.ts";
import {
  color,
  statusField as coloredStatusField,
  fact as factColor,
  heading,
  type ObservabilityTheme,
  phase,
  reliability,
  state,
  strong,
  surface,
} from "./observability-theme.ts";

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);
const VIEW_ORDER = ["status", "runs", "facts", "catalog"] as const;

export type PhenixUiView = (typeof VIEW_ORDER)[number];
type UiPane = 0 | 1 | 2;
type RunViewerMode = "diagram" | "transcript";

const PANE_LABELS: Readonly<Record<PhenixUiView, readonly string[]>> = {
  status: ["Overview"],
  runs: ["Run tree", "Diagram", "Inspector"],
  facts: ["Fact list", "Detail"],
  catalog: ["Definitions", "Preview"],
};

export interface PhenixUiTarget {
  readonly view: PhenixUiView;
  readonly selector?: string;
}

export interface PhenixUiSnapshot {
  readonly tree: RunTree;
  readonly facts: readonly RunFact[];
  readonly sequence: number;
  readonly profile: SessionProfile;
  readonly diagnostics: DiagnosticSummary;
  readonly integrations: string;
  readonly definitions: readonly AnyDefinition[];
}

export interface PhenixUiOptions {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly initial: PhenixUiTarget;
  readonly snapshot: PhenixUiSnapshot;
  readonly load: () => Promise<PhenixUiSnapshot>;
  readonly loadTranscript: (node: RunTreeNode) => Promise<NativeRunTranscript>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly onClose: () => void;
}

interface MouseEvent {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
}

interface RowHit {
  readonly view: PhenixUiView;
  readonly id: string;
  readonly pane: UiPane;
}

interface RenderLayout {
  readonly width: number;
  readonly height: number;
  readonly bodyStart: number;
  readonly bodyHeight: number;
  readonly sidebarWidth: number;
}

interface PreviewCache {
  readonly key: string;
  readonly lines: readonly string[];
}

type StatusTarget =
  | { readonly id: string; readonly kind: "run"; readonly item: RunTreeNode }
  | { readonly id: string; readonly kind: "fact"; readonly item: RunFact };

export async function loadPhenixUiSnapshot(
  runtime: PhenixRuntime,
  rootRunId: RunId,
  integrations: string,
): Promise<PhenixUiSnapshot> {
  const [tree, facts, profile, diagnostics, available] = await Promise.all([
    runtime.queries.runTree(rootRunId),
    runtime.queries.facts(rootRunId),
    runtime.profiles.current(rootRunId),
    runtime.diagnostics.summary(rootRunId),
    runtime.catalog.listAvailable(rootRunId),
  ]);
  return {
    tree,
    facts,
    sequence: runtime.sequence(rootRunId),
    profile,
    diagnostics,
    integrations,
    definitions: available.map(
      (summary) => runtime.catalog.get(definitionRef(summary.id)) as AnyDefinition,
    ),
  };
}

export function parsePhenixUiTarget(raw: string): PhenixUiTarget | undefined {
  const [viewToken, ...selectorTokens] = raw.trim().split(/\s+/).filter(Boolean);
  if (!viewToken) return { view: "status" };
  const normalized = viewToken.toLowerCase();
  const view =
    normalized === "run" || normalized === "runs"
      ? "runs"
      : normalized === "fact" || normalized === "facts"
        ? "facts"
        : normalized === "catalog"
          ? "catalog"
          : normalized === "status"
            ? "status"
            : undefined;
  if (!view) return undefined;
  const selector = selectorTokens.join(" ").trim();
  if (selector && (view === "status" || view === "facts")) return undefined;
  return selector ? { view, selector } : { view };
}

export function parseSgrMouse(data: string): MouseEvent | undefined {
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

export class PhenixUi implements Component {
  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly load: () => Promise<PhenixUiSnapshot>;
  private readonly loadTranscript: (node: RunTreeNode) => Promise<NativeRunTranscript>;
  private readonly onClose: () => void;
  private readonly unsubscribe: () => void;
  private snapshot: PhenixUiSnapshot;
  private view: PhenixUiView;
  private readonly panes: Record<PhenixUiView, UiPane> = {
    status: 0,
    runs: 0,
    facts: 0,
    catalog: 0,
  };
  private readonly filters: Record<PhenixUiView, string> = {
    status: "",
    runs: "",
    facts: "",
    catalog: "",
  };
  private filtering = false;
  private help = false;
  private goPrefix = false;
  private refreshing = false;
  private pendingRefresh = false;
  private disposed = false;
  private runViewerMode: RunViewerMode = "diagram";
  private readonly transcriptCache = new Map<string, NativeRunTranscript>();
  private readonly transcriptLoading = new Set<string>();
  private previewCache: PreviewCache | undefined;
  private layout: RenderLayout = {
    width: 1,
    height: 1,
    bodyStart: 3,
    bodyHeight: 1,
    sidebarWidth: 1,
  };
  private readonly rowHits = new Map<number, RowHit>();
  private tabHits: readonly {
    readonly view: PhenixUiView;
    readonly start: number;
    readonly end: number;
  }[] = [];

  private readonly statusList: ListView<StatusTarget>;
  private readonly runTree: TreeView<RunTreeNode>;
  private readonly factList: ListView<RunFact>;
  private readonly definitionList: ListView<AnyDefinition>;
  private readonly runViewer = new TerminalView();
  private readonly runInspector = new TerminalView();
  private readonly factDetail = new TerminalView();
  private readonly catalogPreview = new TerminalView();

  private get pane(): UiPane {
    return this.panes[this.view];
  }

  private set pane(value: UiPane) {
    this.panes[this.view] = value;
  }

  private get filter(): string {
    return this.filters[this.view];
  }

  private set filter(value: string) {
    this.filters[this.view] = value;
  }

  constructor(options: PhenixUiOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.load = options.load;
    this.loadTranscript = options.loadTranscript;
    this.onClose = options.onClose;
    this.snapshot = options.snapshot;
    this.view = options.initial.view;
    this.statusList = new ListView<StatusTarget>(
      {
        id: (target) => target.id,
        render: (target, context) => this.renderStatusTarget(target, context.width, context),
      },
      { selectFirstItem: true },
    );
    this.runTree = new TreeView<RunTreeNode>(
      {
        id: (node) => String(node.run.id),
        children: (node) => this.visibleRunChildren(node),
        render: (node, context) => this.renderRunNode(node, context.width, context),
      },
      { selectFirstItem: true, indent: "  " },
    );
    this.factList = new ListView<RunFact>(
      {
        id: (fact) => factId(fact),
        render: (fact, context) => this.renderSelectableLine(
          formatFactLine(this.theme, fact),
          context.width,
          context.selected,
          context.focused,
        ),
      },
      { selectFirstItem: true },
    );
    this.definitionList = new ListView<AnyDefinition>(
      {
        id: (definition) => String(definition.id),
        render: (definition, context) => {
          const kind =
            definition.kind === "workflow"
              ? color(this.theme, "accent", "W")
              : color(this.theme, "success", "A");
          return this.renderSelectableLine(
            `${kind} ${strong(this.theme, definitionLabel(String(definition.id)))}`,
            context.width,
            context.selected,
            context.focused,
          );
        },
      },
      { selectFirstItem: true },
    );
    this.initializeRunTree(options.snapshot.tree.root);
    this.syncCollections();
    this.applyInitialSelector(options.initial.selector);
    this.unsubscribe = options.subscribe(() => {
      void this.refresh();
    });
    this.tui.terminal.write(MOUSE_ENABLE);
  }

  invalidate(): void {
    this.previewCache = undefined;
    for (const transcript of this.transcriptCache.values()) transcript.component.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.tui.terminal.write(MOUSE_DISABLE);
  }

  handleInput(data: string): void {
    const mouse = parseSgrMouse(data);
    if (mouse) {
      this.handleMouse(mouse);
      return;
    }
    if (this.help) {
      if (matchesKey(data, "escape") || data === "?" || data === "q") {
        this.help = false;
        this.requestRender();
      }
      return;
    }
    if (this.filtering) {
      this.handleFilterInput(data);
      return;
    }
    if (this.goPrefix) {
      this.goPrefix = false;
      const mnemonic: Readonly<Record<string, PhenixUiView>> = {
        s: "status",
        r: "runs",
        f: "facts",
        c: "catalog",
      };
      const target = mnemonic[data.toLowerCase()];
      if (target) this.switchView(target);
      else this.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.onClose();
      return;
    }
    if (data === "?") {
      this.help = true;
      this.requestRender();
      return;
    }
    if (data === "/") {
      this.filtering = true;
      this.requestRender();
      return;
    }
    if (data === "g") {
      this.goPrefix = true;
      this.requestRender();
      return;
    }
    if (data === "r" || data === "R") {
      void this.refresh();
      return;
    }
    if (/^[1-4]$/.test(data)) {
      const target = VIEW_ORDER[Number(data) - 1];
      if (target) this.switchView(target);
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const delta = matchesKey(data, "shift+tab") ? -1 : 1;
      this.pane = wrapPane(this.pane, delta, this.paneCount());
      this.requestRender();
      return;
    }
    switch (this.view) {
      case "status":
        this.handleStatusInput(data);
        break;
      case "runs":
        this.handleRunsInput(data);
        break;
      case "facts":
        this.handleFactsInput(data);
        break;
      case "catalog":
        this.handleCatalogInput(data);
        break;
    }
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    const showFocusBar = this.paneCount() > 1;
    const bodyStart = showFocusBar ? 4 : 3;
    this.layout = {
      width,
      height,
      bodyStart,
      bodyHeight: Math.max(1, height - bodyStart),
      sidebarWidth: Math.min(44, Math.max(26, Math.floor(width * 0.34))),
    };
    this.rowHits.clear();
    this.syncCollections();
    if (width < 42 || height < 9) return this.renderSmall(width, height);
    const chrome = [this.renderTitleBar(width), this.renderTabs(width)];
    if (showFocusBar) chrome.push(this.renderFocusBar(width));
    const body = this.help ? this.renderHelp(width, this.layout.bodyHeight) : this.renderView();
    const footer = this.renderFooter(width);
    return [...chrome, ...fitHeight(body, this.layout.bodyHeight, width), footer];
  }

  private renderTitleBar(width: number): string {
    const active = countActive(this.snapshot.tree.root);
    const health =
      this.snapshot.diagnostics.counts.error > 0
        ? color(this.theme, "error", `${this.snapshot.diagnostics.counts.error} errors`)
        : this.snapshot.diagnostics.counts.warning > 0
          ? color(this.theme, "warning", `${this.snapshot.diagnostics.counts.warning} warnings`)
          : color(this.theme, "success", "healthy");
    const title = heading(this.theme, ` Phenix · ${capitalize(this.view)}`);
    const status = `${color(this.theme, active > 0 ? "warning" : "success", active > 0 ? `${active} active` : "idle")}  ${health}  ${strong(this.theme, this.snapshot.profile.agent)}/${color(this.theme, "accent", this.snapshot.profile.modelSet)}/${this.snapshot.profile.difficulty} `;
    const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(status));
    return surface(
      this.theme,
      "customMessageBg",
      fitViewLine(`${title}${" ".repeat(gap)}${status}`, width),
    );
  }

  private renderTabs(width: number): string {
    return this.renderSegments(
      VIEW_ORDER.map((view, index) => `${index + 1} ${capitalize(view)}`),
      VIEW_ORDER.indexOf(this.view),
      width,
      true,
    );
  }

  private renderFocusBar(width: number): string {
    return this.renderSegments(this.paneLabels(), this.pane, width, false);
  }

  private paneLabels(): readonly string[] {
    if (this.view === "runs") return ["Run tree", capitalize(this.runViewerMode), "Inspector"];
    return PANE_LABELS[this.view];
  }

  private renderSegments(
    labels: readonly string[],
    activeIndex: number,
    width: number,
    recordTabHits: boolean,
  ): string {
    const widths = distributeWidths(width, labels.length);
    let column = 1;
    const hits: Array<{
      readonly view: PhenixUiView;
      readonly start: number;
      readonly end: number;
    }> = [];
    const segments = labels.map((label, index) => {
      const segmentWidth = widths[index] ?? 0;
      const start = column;
      const end = start + segmentWidth - 1;
      if (recordTabHits) {
        const view = VIEW_ORDER[index];
        if (view) hits.push({ view, start, end });
      }
      column = end + 1;
      const text = centerToWidth(label, segmentWidth);
      const active = index === activeIndex;
      return surface(
        this.theme,
        active ? "selectedBg" : "customMessageBg",
        active ? strong(this.theme, text) : color(this.theme, "muted", text),
      );
    });
    if (recordTabHits) this.tabHits = hits;
    return fitViewLine(segments.join(""), width);
  }

  private renderView(): string[] {
    switch (this.view) {
      case "status":
        return this.renderStatus();
      case "runs":
        return this.renderRuns();
      case "facts":
        return this.renderFacts();
      case "catalog":
        return this.renderCatalog();
    }
  }

  private renderStatus(): string[] {
    const width = this.layout.width;
    const header = [
      heading(this.theme, " Session"),
      ` ${coloredStatusField(this.theme, "agent", this.snapshot.profile.agent, "text")}  ${coloredStatusField(this.theme, "model", this.snapshot.profile.modelSet, "accent")}  ${coloredStatusField(this.theme, "difficulty", this.snapshot.profile.difficulty, "warning")}  ${coloredStatusField(this.theme, "integrations", this.snapshot.integrations, "success")}`,
      ` ${coloredStatusField(this.theme, "sequence", String(this.snapshot.sequence), "accent")}  ${coloredStatusField(this.theme, "diagnostics", `${this.snapshot.diagnostics.counts.warning} warning / ${this.snapshot.diagnostics.counts.error} error`, this.snapshot.diagnostics.counts.error > 0 ? "error" : this.snapshot.diagnostics.counts.warning > 0 ? "warning" : "success")}`,
      "",
      heading(this.theme, " Active execution and recent facts"),
    ];
    const height = Math.max(0, this.layout.bodyHeight - header.length);
    const frame = this.statusList.render(width, height, true);
    this.recordHits("status", 0, frame.visibleItemIds, header.length);
    if (this.statusList.itemCount === 0) {
      frame.lines[0] = fitViewLine(` ${color(this.theme, "success", "✓ idle")}`, width);
    }
    return [...header.map((line) => fitViewLine(line, width)), ...frame.lines];
  }

  private renderRuns(): string[] {
    const width = this.layout.width;
    const height = this.layout.bodyHeight;
    const selected = this.selectedRun();
    if (width < 82) {
      return this.pane === 0
        ? this.renderRunTreePane(width, height)
        : this.pane === 1
          ? this.renderRunViewerPane(selected, width, height)
          : this.renderRunInspectorPane(selected, width, height);
    }
    if (width < 126 && this.pane === 2) {
      return this.renderRunInspectorPane(selected, width, height);
    }
    const treeWidth = Math.min(46, Math.max(30, Math.floor(width * 0.32)));
    const inspectorWidth = width >= 126 ? Math.min(42, Math.floor(width * 0.28)) : 0;
    const previewWidth = width - treeWidth - inspectorWidth - (inspectorWidth > 0 ? 2 : 1);
    const tree = this.renderRunTreePane(treeWidth, height);
    const preview = this.renderRunViewerPane(selected, previewWidth, height);
    const inspector =
      inspectorWidth > 0 ? this.renderRunInspectorPane(selected, inspectorWidth, height) : [];
    return Array.from({ length: height }, (_, row) => {
      const left = tree[row] ?? " ".repeat(treeWidth);
      const middle = preview[row] ?? " ".repeat(previewWidth);
      if (inspectorWidth === 0) return `${left} ${middle}`;
      const right = inspector[row] ?? " ".repeat(inspectorWidth);
      return `${left} ${middle} ${right}`;
    });
  }

  private renderRunTreePane(width: number, height: number): string[] {
    this.runTree.setRoots([this.snapshot.tree.root]);
    const frame = this.runTree.render(width, height, this.pane === 0);
    this.recordHits("runs", 0, frame.visibleNodeIds, 0);
    return renderPanel({
      lines: frame.lines,
      width,
      height,
      style: { surface: (line) => this.panelSurface(line, 0) },
    }).lines as string[];
  }

  private renderRunViewerPane(node: RunTreeNode, width: number, height: number): string[] {
    return this.runViewerMode === "diagram"
      ? this.renderRunDiagramPane(node, width, height)
      : this.renderRunTranscriptPane(node, width, height);
  }

  private renderRunDiagramPane(node: RunTreeNode, width: number, height: number): string[] {
    this.runViewer.setLines(this.runPreviewLines(node));
    return this.renderTerminalPanel(this.runViewer, width, height, 1);
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
    } else {
      lines.push(...transcript.component.render(width));
    }
    this.runViewer.setLines(lines);
    return this.renderTerminalPanel(this.runViewer, width, height, 1);
  }

  private renderRunInspectorPane(node: RunTreeNode, width: number, height: number): string[] {
    const run = node.run;
    const model = run.resolvedModel;
    const facts = this.snapshot.facts.filter((item) => item.runId === run.id).slice(-5);
    this.runInspector.setLines([
      heading(this.theme, " Inspector"),
      strong(this.theme, definitionLabel(String(run.definitionId))),
      statusField("id", shortRunId(String(run.id))),
      statusField("kind", run.kind),
      statusField("state", run.state),
      statusField("ownership", run.ownership),
      statusField("requested", compactTimestamp(run.requestedAt)),
      statusField("session", run.pi?.sessionId ?? "none"),
      statusField("transcript", run.pi?.sessionFile ? "persisted" : "none"),
      statusField(
        "model",
        model ? `${model.concrete.provider}/${model.concrete.model}` : "unresolved",
      ),
      statusField("thinking", model?.thinking ?? "unresolved"),
      statusField("tools", run.compiled.tools.join(", ") || "none"),
      statusField("timeout", `${run.compiled.limits.timeoutMs} ms`),
      statusField("children", String(node.children.length)),
      "",
      heading(this.theme, " Latest facts"),
      ...facts.map((item) => formatFactLine(this.theme, item)),
    ]);
    return this.renderTerminalPanel(this.runInspector, width, height, 2);
  }

  private renderFacts(): string[] {
    const width = this.layout.width;
    const height = this.layout.bodyHeight;
    const selected = this.factList.selectedItem;
    if (width < 76) {
      return this.pane === 0
        ? this.renderFactList(width, height)
        : this.renderFactDetail(selected, width, height);
    }
    const listWidth = Math.min(68, Math.max(38, Math.floor(width * 0.55)));
    const detailWidth = width - listWidth - 1;
    const list = this.renderFactList(listWidth, height);
    const detail = this.renderFactDetail(selected, detailWidth, height);
    return Array.from(
      { length: height },
      (_, row) => `${list[row] ?? " ".repeat(listWidth)} ${detail[row] ?? " ".repeat(detailWidth)}`,
    );
  }

  private renderFactList(width: number, height: number): string[] {
    const frame = this.factList.render(width, height, this.pane === 0);
    this.recordHits("facts", 0, frame.visibleItemIds, 0);
    return renderPanel({
      lines: frame.lines,
      width,
      height,
      style: { surface: (line) => this.panelSurface(line, 0) },
    }).lines as string[];
  }

  private renderFactDetail(item: RunFact | undefined, width: number, height: number): string[] {
    this.factDetail.setLines(
      item
        ? [
            heading(this.theme, " Fact detail"),
            statusField("time", item.timestamp),
            statusField("run", String(item.runId)),
            statusField("kind", item.kind),
            statusField("reliability", item.reliability),
            item.subject ? statusField("subject", item.subject) : "",
            "",
            strong(this.theme, item.summary),
          ].filter((line) => line !== "")
        : [heading(this.theme, " Fact detail"), color(this.theme, "muted", "No facts recorded.")],
    );
    return this.renderTerminalPanel(this.factDetail, width, height, 1);
  }

  private renderCatalog(): string[] {
    const width = this.layout.width;
    const height = this.layout.bodyHeight;
    const selected = this.definitionList.selectedItem;
    if (width < 76) {
      return this.pane === 0
        ? this.renderDefinitionSidebar(selected, width, height)
        : this.renderDefinitionPreview(selected, width, height);
    }
    const sidebarWidth = this.layout.sidebarWidth;
    const previewWidth = width - sidebarWidth - 1;
    const sidebar = this.renderDefinitionSidebar(selected, sidebarWidth, height);
    const preview = this.renderDefinitionPreview(selected, previewWidth, height);
    return Array.from(
      { length: height },
      (_, row) => `${sidebar[row] ?? " ".repeat(sidebarWidth)} ${preview[row] ?? " ".repeat(previewWidth)}`,
    );
  }

  private renderDefinitionSidebar(
    selected: AnyDefinition | undefined,
    width: number,
    height: number,
  ): string[] {
    const inspectorHeight = Math.min(
      8,
      Math.max(4, Math.floor(height * 0.45)),
      Math.max(1, height - 1),
    );
    const listHeight = Math.max(1, height - inspectorHeight);
    const frame = this.definitionList.render(width, listHeight, this.pane === 0);
    this.recordHits("catalog", 0, frame.visibleItemIds, 0);
    const list = renderPanel({
      lines: frame.lines,
      width,
      height: listHeight,
      style: { surface: (line) => this.panelSurface(line, 0) },
    }).lines;
    const details = renderPanel({
      lines: this.definitionInspectorLines(selected, width),
      width,
      height: inspectorHeight,
      style: { surface: (line) => surface(this.theme, "customMessageBg", line) },
    }).lines;
    return [...list, ...details];
  }

  private definitionInspectorLines(
    definition: AnyDefinition | undefined,
    width: number,
  ): readonly string[] {
    if (!definition) {
      return [
        heading(this.theme, " Selected definition"),
        color(this.theme, "muted", " No definitions match the current filter."),
      ];
    }
    const identity = color(this.theme, "muted", ` ${definition.kind} · ${String(definition.id)}`);
    const description = color(
      this.theme,
      "text",
      ` ${truncate(definition.description, Math.max(12, width - 2))}`,
    );
    if (definition.kind === "workflow") {
      const nodes = definition.graph.nodes.length;
      const edges = definition.graph.edges.length;
      const nodeCount = `${nodes} ${nodes === 1 ? "node" : "nodes"}`;
      const transitionCount = `${edges} ${edges === 1 ? "transition" : "transitions"}`;
      return [
        heading(this.theme, " Selected definition"),
        strong(this.theme, ` ${definition.title}`),
        identity,
        description,
        color(this.theme, "muted", ` ${nodeCount} · ${transitionCount}`),
        color(
          this.theme,
          "muted",
          ` entry ${definition.graph.entry} · ${definition.limits.timeoutMs}ms · parallel ${definition.limits.maxParallelism}`,
        ),
      ];
    }
    const model =
      definition.model.kind === "session"
        ? "session"
        : `${definition.model.provider}/${definition.model.model}`;
    const tools = definition.tools.allow.length
      ? truncate(definition.tools.allow.join(", "), Math.max(12, width - 9))
      : "none";
    return [
      heading(this.theme, " Selected definition"),
      strong(this.theme, ` ${definition.title}`),
      identity,
      description,
      ` ${coloredStatusField(this.theme, "model", model, "accent")}`,
      ` ${coloredStatusField(this.theme, "thinking", definition.thinking, "warning")}`,
      ` ${coloredStatusField(this.theme, "tools", tools, "text")}`,
    ];
  }

  private renderDefinitionPreview(
    definition: AnyDefinition | undefined,
    width: number,
    height: number,
  ): string[] {
    this.catalogPreview.setLines(this.catalogPreviewLines(definition));
    return this.renderTerminalPanel(this.catalogPreview, width, height, 1);
  }

  private renderTerminalPanel(
    viewport: TerminalView,
    width: number,
    height: number,
    pane: UiPane,
  ): string[] {
    const frame = viewport.render(width, height);
    return renderPanel({
      lines: frame.lines,
      width,
      height,
      style: { surface: (line) => this.panelSurface(line, pane) },
    }).lines as string[];
  }

  private renderHelp(width: number, height: number): string[] {
    const lines = [
      heading(this.theme, " Phenix UI help"),
      "",
      "1–4                 switch Status, Runs, Facts, Catalog",
      "g s/r/f/c           mnemonic view navigation",
      "Tab / Shift+Tab     switch panes",
      "arrows or h/j/k/l   navigate or pan the active pane",
      "PageUp/PageDown     page vertically",
      "Home/End            jump to boundaries",
      "Enter               open the selected run or session",
      "v                   toggle run diagram/transcript",
      "Space               expand or collapse a run",
      "/                   filter the active view",
      "r                   refresh immediately",
      "?                   close this help",
      "Esc or q            close the UI",
      "",
      "Mouse: click tabs and list rows; wheel scrolls the pane under the pointer.",
    ];
    return renderPanel({
      lines,
      width,
      height,
      style: { surface: (line) => line },
    }).lines as string[];
  }

  private renderSmall(width: number, height: number): string[] {
    return renderPanel({
      lines: [
        color(this.theme, "warning", " Terminal is too small for the full-screen interface."),
        " Resize to at least 42 columns and 8 rows.",
        " Esc closes the UI.",
      ],
      width,
      height,
      title: heading(this.theme, " Phenix UI"),
      style: { surface: (line) => line, title: (title) => title },
    }).lines as string[];
  }

  private renderFooter(width: number): string {
    const text = this.filtering
      ? ` Filter: ${this.filter}`
      : this.filter
        ? ` /${this.filter} · ? help · q close`
        : " ? help · / filter · q close";
    return surface(
      this.theme,
      "customMessageBg",
      fitViewLine(color(this.theme, "muted", text), width),
    );
  }

  private handleStatusInput(data: string): void {
    const event = this.dispatchListInput(this.statusList, data, this.layout.bodyHeight - 5);
    if (event?.kind === "activate") this.openStatusTarget(event.item);
  }

  private handleRunsInput(data: string): void {
    const selected = this.selectedRun();
    if ((data === "v" || data === "V") && selected) {
      this.toggleRunViewer(selected);
      return;
    }
    if (this.pane === 0) {
      let event: TreeViewEvent<RunTreeNode> | undefined;
      if (isUp(data)) event = this.runTree.dispatch({ kind: "move", direction: -1 }, this.layout.bodyHeight);
      else if (isDown(data)) event = this.runTree.dispatch({ kind: "move", direction: 1 }, this.layout.bodyHeight);
      else if (matchesKey(data, "home")) event = this.runTree.dispatch({ kind: "edge", edge: "first" }, this.layout.bodyHeight);
      else if (matchesKey(data, "end")) event = this.runTree.dispatch({ kind: "edge", edge: "last" }, this.layout.bodyHeight);
      else if (data === " ") event = this.runTree.dispatch({ kind: "toggle" }, this.layout.bodyHeight);
      else if (matchesKey(data, "right")) {
        event = this.runTree.dispatch({ kind: "expand" }, this.layout.bodyHeight);
        if (!event) this.pane = 1;
      } else if (matchesKey(data, "left")) {
        event = this.runTree.dispatch({ kind: "collapse" }, this.layout.bodyHeight);
      } else if (matchesKey(data, "enter")) {
        this.openSelectedRun();
        return;
      } else return;
      this.previewCache = undefined;
      this.requestRender();
      return;
    }
    if (this.pane === 1) {
      if (!this.dispatchTerminalInput(this.runViewer, data, this.layout.bodyHeight)) return;
      this.requestRender();
      return;
    }
    if (!this.dispatchTerminalInput(this.runInspector, data, this.layout.bodyHeight)) return;
    this.requestRender();
  }

  private handleFactsInput(data: string): void {
    if (this.pane === 0) {
      const event = this.dispatchListInput(this.factList, data, this.layout.bodyHeight);
      if (event?.kind === "activate" || matchesKey(data, "right")) this.pane = 1;
      this.factDetail.clear();
      return;
    }
    if (matchesKey(data, "left")) {
      this.pane = 0;
      this.requestRender();
      return;
    }
    if (!this.dispatchTerminalInput(this.factDetail, data, this.layout.bodyHeight)) return;
    this.requestRender();
  }

  private handleCatalogInput(data: string): void {
    if (this.pane === 0) {
      const event = this.dispatchListInput(this.definitionList, data, this.layout.bodyHeight);
      if (event?.kind === "activate" || matchesKey(data, "right")) this.pane = 1;
      this.catalogPreview.clear();
      this.previewCache = undefined;
      return;
    }
    if (matchesKey(data, "left")) {
      this.pane = 0;
      this.requestRender();
      return;
    }
    if (!this.dispatchTerminalInput(this.catalogPreview, data, this.layout.bodyHeight)) return;
    this.requestRender();
  }

  private dispatchListInput<T>(
    list: ListView<T>,
    data: string,
    height: number,
  ): ReturnType<ListView<T>["dispatch"]> {
    let event: ReturnType<ListView<T>["dispatch"]>;
    if (isUp(data)) event = list.dispatch({ kind: "move", direction: -1 }, height);
    else if (isDown(data)) event = list.dispatch({ kind: "move", direction: 1 }, height);
    else if (matchesKey(data, "pageUp")) event = list.dispatch({ kind: "page", direction: -1 }, height);
    else if (matchesKey(data, "pageDown")) event = list.dispatch({ kind: "page", direction: 1 }, height);
    else if (matchesKey(data, "home")) event = list.dispatch({ kind: "edge", edge: "first" }, height);
    else if (matchesKey(data, "end")) event = list.dispatch({ kind: "edge", edge: "last" }, height);
    else if (matchesKey(data, "enter")) event = list.dispatch({ kind: "activate" }, height);
    else return undefined;
    this.requestRender();
    return event;
  }

  private dispatchTerminalInput(view: TerminalView, data: string, height: number): boolean {
    if (isLeft(data)) view.dispatch({ kind: "horizontal", columns: -4 }, height);
    else if (isRight(data)) view.dispatch({ kind: "horizontal", columns: 4 }, height);
    else if (isUp(data)) view.dispatch({ kind: "scroll", lines: -1 }, height);
    else if (isDown(data)) view.dispatch({ kind: "scroll", lines: 1 }, height);
    else if (matchesKey(data, "pageUp")) view.dispatch({ kind: "page", direction: -1 }, height);
    else if (matchesKey(data, "pageDown")) view.dispatch({ kind: "page", direction: 1 }, height);
    else if (matchesKey(data, "home")) {
      view.dispatch({ kind: "home" }, height);
      view.dispatch({ kind: "horizontal", columns: -Number.MAX_SAFE_INTEGER }, height);
    } else if (matchesKey(data, "end")) {
      view.dispatch({ kind: "end" }, height);
      view.dispatch({ kind: "horizontal", columns: Number.MAX_SAFE_INTEGER }, height);
    } else return false;
    return true;
  }

  private handleFilterInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.filtering = false;
    } else if (matchesKey(data, "enter")) {
      this.filtering = false;
      this.resetSelectionForFilter();
    } else if (matchesKey(data, "backspace")) {
      this.filter = this.filter.slice(0, -1);
      this.resetSelectionForFilter();
    } else if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.filter += data;
      this.resetSelectionForFilter();
    } else {
      return;
    }
    this.syncCollections();
    this.requestRender();
  }

  private handleMouse(event: MouseEvent): void {
    if (event.release) return;
    if (event.button === 64 || event.button === 65) {
      const direction = event.button === 64 ? -1 : 1;
      this.handleMouseWheel(direction, event.x);
      return;
    }
    if (event.button !== 0) return;
    const tab = this.tabHits.find((item) => event.x >= item.start && event.x <= item.end);
    if (event.y === 2 && tab) {
      this.switchView(tab.view);
      return;
    }
    const hit = this.rowHits.get(event.y);
    if (!hit) return;
    this.view = hit.view;
    this.pane = hit.pane;
    if (hit.view === "status") {
      this.statusList.dispatch({ kind: "select", id: hit.id }, this.layout.bodyHeight);
      this.openStatusTarget(this.statusList.selectedItem);
    } else if (hit.view === "runs") {
      this.runTree.dispatch({ kind: "select", id: hit.id }, this.layout.bodyHeight);
      this.resetRunPanes();
    } else if (hit.view === "facts") {
      this.factList.dispatch({ kind: "select", id: hit.id }, this.layout.bodyHeight);
      this.factDetail.clear();
    } else if (hit.view === "catalog") {
      this.definitionList.dispatch({ kind: "select", id: hit.id }, this.layout.bodyHeight);
      this.catalogPreview.clear();
      this.previewCache = undefined;
    }
    this.requestRender();
  }

  private handleMouseWheel(direction: number, x: number): void {
    if (this.view === "runs" && this.layout.width >= 82) {
      const treeWidth = Math.min(46, Math.max(30, Math.floor(this.layout.width * 0.32)));
      if (x <= treeWidth) this.pane = 0;
      else if (this.layout.width >= 126) {
        const inspectorWidth = Math.min(42, Math.floor(this.layout.width * 0.28));
        this.pane = x > this.layout.width - inspectorWidth ? 2 : 1;
      } else this.pane = 1;
    } else if (this.view === "facts" && this.layout.width >= 76) {
      const listWidth = Math.min(68, Math.max(38, Math.floor(this.layout.width * 0.55)));
      this.pane = x <= listWidth ? 0 : 1;
    } else if (this.view === "catalog" && this.layout.width >= 76) {
      this.pane = x <= this.layout.sidebarWidth ? 0 : 1;
    }
    const data = direction < 0 ? "\x1b[A" : "\x1b[B";
    switch (this.view) {
      case "status":
        this.handleStatusInput(data);
        break;
      case "runs":
        this.handleRunsInput(data);
        break;
      case "facts":
        this.handleFactsInput(data);
        break;
      case "catalog":
        this.handleCatalogInput(data);
        break;
    }
  }

  private renderStatusTarget(
    target: StatusTarget,
    width: number,
    context: { readonly selected: boolean; readonly focused: boolean },
  ): string {
    const line =
      target.kind === "run"
        ? runSummary(this.theme, target.item, depthOf(this.snapshot.tree.root, target.item.run.id))
        : formatFactLine(this.theme, target.item);
    return this.renderSelectableLine(line, width, context.selected, context.focused);
  }

  private renderRunNode(
    node: RunTreeNode,
    width: number,
    context: { readonly selected: boolean; readonly focused: boolean },
  ): string {
    const run = node.run;
    const symbol = state(this.theme, run.state, runStateSymbol(run.state));
    const model = run.resolvedModel
      ? ` ${color(this.theme, "muted", `${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`)}`
      : "";
    const line = `${symbol} ${strong(this.theme, definitionLabel(String(run.definitionId)))} ${state(this.theme, run.state, run.state)}${model}`;
    return this.renderSelectableLine(line, width, context.selected, context.focused);
  }

  private renderSelectableLine(
    text: string,
    width: number,
    selected: boolean,
    focused: boolean,
  ): string {
    const line = fitViewLine(`  ${text}`, width);
    if (!selected) return line;
    return surface(
      this.theme,
      focused ? "selectedBg" : "userMessageBg",
      focused ? strong(this.theme, line) : line,
    );
  }

  private panelSurface(line: string, pane: UiPane): string {
    return surface(
      this.theme,
      this.pane === pane ? "userMessageBg" : "customMessageBg",
      fitViewLine(line, visibleWidth(line)),
    );
  }

  private recordHits(
    view: PhenixUiView,
    pane: UiPane,
    ids: readonly string[],
    rowOffset: number,
  ): void {
    ids.forEach((id, row) => {
      this.rowHits.set(this.layout.bodyStart + rowOffset + row, { view, id, pane });
    });
  }

  private statusTargets(): readonly StatusTarget[] {
    const runs = flattenRuns(this.snapshot.tree.root)
      .filter((item) => item.node.run.id !== this.snapshot.tree.root.run.id)
      .filter((item) => !TERMINAL_STATES.has(item.node.run.state))
      .slice(0, Math.max(3, Math.floor(this.layout.bodyHeight / 2) - 4));
    const facts = this.filteredFacts().slice(-5);
    return [
      ...runs.map((item) => ({
        id: `run:${item.node.run.id}`,
        kind: "run" as const,
        item: item.node,
      })),
      ...facts.map((item) => ({ id: `fact:${factId(item)}`, kind: "fact" as const, item })),
    ];
  }

  private openStatusTarget(target: StatusTarget | undefined): void {
    if (!target) return;
    if (target.kind === "run") {
      this.runTree.setSelectedId(String(target.item.run.id));
      this.runViewerMode = target.item.run.pi?.sessionFile ? "transcript" : "diagram";
      this.pane = 1;
      this.resetRunPanes();
      if (this.runViewerMode === "transcript") void this.ensureRunTranscript(target.item);
      this.switchView("runs");
      return;
    }
    this.factList.setSelectedId(factId(target.item));
    this.switchView("facts");
  }

  private switchView(view: PhenixUiView): void {
    this.view = view;
    this.goPrefix = false;
    this.requestRender();
  }

  private paneCount(): number {
    if (this.view === "status") return 1;
    if (this.view === "runs") return 3;
    return 2;
  }

  private filteredFacts(): readonly RunFact[] {
    const normalized = this.filter.toLowerCase();
    if (!normalized) return this.snapshot.facts;
    return this.snapshot.facts.filter((item) =>
      [item.timestamp, item.runId, item.kind, item.reliability, item.summary, item.subject]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized)),
    );
  }

  private filteredDefinitions(): readonly AnyDefinition[] {
    const normalized = this.filter.toLowerCase();
    const ordered = [...this.snapshot.definitions].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "workflow" ? -1 : 1;
      return String(left.id).localeCompare(String(right.id));
    });
    if (!normalized) return ordered;
    return ordered.filter((item) =>
      [item.id, item.kind, item.title, item.description]
        .map(String)
        .some((value) => value.toLowerCase().includes(normalized)),
    );
  }

  private visibleRunChildren(node: RunTreeNode): readonly RunTreeNode[] {
    const normalized = this.filter.toLowerCase();
    if (!normalized) return node.children;
    return node.children.filter((child) => runSubtreeMatches(child, normalized));
  }

  private runPreviewLines(node: RunTreeNode): readonly string[] {
    const key = `run:${this.snapshot.sequence}:${node.run.id}`;
    if (this.previewCache?.key === key) return this.previewCache.lines;
    let lines: readonly string[];
    try {
      const root =
        node.run.kind === "root" ? node : { ...this.snapshot.tree.root, children: [node] };
      lines = renderRunTreeSequence({ root }, { expanded: true, theme: this.theme }).split("\n");
    } catch (error) {
      lines = [`Unable to render run sequence: ${errorMessage(error)}`];
    }
    this.previewCache = { key, lines };
    return lines;
  }

  private catalogPreviewLines(definition: AnyDefinition | undefined): readonly string[] {
    if (!definition) return ["No definitions match the current filter."];
    const key = `catalog:${definition.id}`;
    if (this.previewCache?.key === key) return this.previewCache.lines;
    let lines: readonly string[];
    try {
      lines = renderCatalogDefinition(definition, { theme: this.theme }).split("\n");
    } catch (error) {
      lines = [`Unable to render ${definition.id}: ${errorMessage(error)}`];
    }
    this.previewCache = { key, lines };
    return lines;
  }

  private initializeRunTree(root: RunTreeNode): void {
    this.runTree.setRoots([root]);
    this.runTree.setExpanded(defaultExpandedRunIds(root));
    this.runTree.setSelectedId(String(root.run.id));
  }

  private syncCollections(): void {
    this.statusList.setItems(this.statusTargets());
    this.runTree.setRoots([this.snapshot.tree.root]);
    this.factList.setItems(this.filteredFacts());
    this.definitionList.setItems(this.filteredDefinitions());
  }

  private applyInitialSelector(selector: string | undefined): void {
    if (!selector) return;
    if (this.view === "runs") {
      const normalized = selector.toLowerCase();
      const match = flattenRuns(this.snapshot.tree.root).find((item) => {
        const id = String(item.node.run.id).toLowerCase();
        return id === normalized || id.endsWith(normalized);
      });
      if (match) this.runTree.setSelectedId(String(match.node.run.id));
      return;
    }
    if (this.view === "catalog") {
      const normalized = selector.toLowerCase();
      const definition = this.filteredDefinitions().find((item) => {
        const id = String(item.id).toLowerCase();
        return (
          id === normalized ||
          id.replace(/^(?:agent|workflow)\./, "") === normalized ||
          item.title.toLowerCase() === normalized
        );
      });
      if (definition) this.definitionList.setSelectedId(String(definition.id));
    }
  }

  private selectedRun(): RunTreeNode {
    return this.runTree.selectedNode ?? this.snapshot.tree.root;
  }

  private openSelectedRun(): void {
    const selected = this.selectedRun();
    this.runViewerMode = selected.run.pi?.sessionFile ? "transcript" : "diagram";
    this.pane = 1;
    this.resetRunPanes();
    if (this.runViewerMode === "transcript") void this.ensureRunTranscript(selected);
    this.requestRender();
  }

  private toggleRunViewer(node: RunTreeNode): void {
    this.runViewerMode = this.runViewerMode === "diagram" ? "transcript" : "diagram";
    this.runViewer.clear();
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
      if (this.runTree.selectedId === key) this.runViewer.clear();
    } catch (error) {
      const component = new Container();
      component.addChild(new Text(`Unable to load Pi transcript: ${errorMessage(error)}`, 0, 0));
      this.transcriptCache.set(key, {
        component,
        sessionId: node.run.pi?.sessionId ?? key,
        ...(node.run.pi?.sessionFile ? { sessionFile: node.run.pi.sessionFile } : {}),
      });
    } finally {
      this.transcriptLoading.delete(key);
      this.requestRender();
    }
  }

  private resetRunPanes(): void {
    this.runViewer.clear();
    this.runInspector.clear();
    this.previewCache = undefined;
  }

  private resetSelectionForFilter(): void {
    switch (this.view) {
      case "status":
        this.statusList.setSelectedId(undefined);
        break;
      case "runs":
        this.runViewer.clear();
        this.runInspector.clear();
        break;
      case "facts":
        this.factList.setSelectedId(undefined);
        this.factDetail.clear();
        break;
      case "catalog":
        this.definitionList.setSelectedId(undefined);
        this.catalogPreview.clear();
        break;
    }
    this.previewCache = undefined;
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
        const snapshot = await this.load();
        if (this.disposed) return;
        this.snapshot = snapshot;
        this.runTree.setExpanded([
          ...this.runTree.expandedIds,
          ...defaultExpandedRunIds(snapshot.tree.root),
        ]);
        this.syncCollections();
        this.previewCache = undefined;
        if (this.view === "runs" && this.runViewerMode === "transcript") {
          void this.ensureRunTranscript(this.selectedRun(), true);
        }
        this.requestRender();
      } while (this.pendingRefresh && !this.disposed);
    } finally {
      this.refreshing = false;
    }
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}

function flattenRuns(
  node: RunTreeNode,
  depth = 0,
  target: Array<{ readonly node: RunTreeNode; readonly depth: number }> = [],
): readonly { readonly node: RunTreeNode; readonly depth: number }[] {
  target.push({ node, depth });
  node.children.forEach((child) => {
    flattenRuns(child, depth + 1, target);
  });
  return target;
}

function defaultExpandedRunIds(root: RunTreeNode): readonly string[] {
  return flattenRuns(root)
    .filter(({ node }) => {
      if (node.children.length === 0) return false;
      return !(
        node.run.kind === "workflow" &&
        TERMINAL_STATES.has(node.run.state)
      );
    })
    .map(({ node }) => String(node.run.id));
}

function runSubtreeMatches(node: RunTreeNode, normalized: string): boolean {
  const run = node.run;
  const model = run.resolvedModel;
  const self = [
    run.id,
    run.definitionId,
    run.state,
    run.kind,
    model?.concrete.provider,
    model?.concrete.model,
    model?.thinking,
    node.activity?.summary,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
  return self || node.children.some((child) => runSubtreeMatches(child, normalized));
}

function countActive(node: RunTreeNode): number {
  return (
    (node.run.kind !== "root" && !TERMINAL_STATES.has(node.run.state) ? 1 : 0) +
    node.children.reduce((sum, child) => sum + countActive(child), 0)
  );
}

function depthOf(root: RunTreeNode, runId: RunId, depth = 0): number {
  if (root.run.id === runId) return depth;
  for (const child of root.children) {
    const nested = depthOf(child, runId, depth + 1);
    if (nested >= 0) return nested;
  }
  return -1;
}

function runSummary(theme: ObservabilityTheme, node: RunTreeNode, depth: number): string {
  const run = node.run;
  const activity = node.activity;
  const label = definitionLabel(String(run.definitionId));
  const model = run.resolvedModel
    ? ` ${color(theme, "muted", `${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`)}`
    : "";
  const current = activity
    ? ` ${phase(theme, activity.phase)} ${color(theme, "muted", activity.summary)}`
    : "";
  return `${"  ".repeat(Math.max(0, depth - 1))}${state(theme, run.state, runStateSymbol(run.state))} ${strong(theme, label)} ${state(theme, run.state, run.state)}${model}${current}`;
}

function runStateSymbol(value: string): string {
  switch (value) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "−";
    case "running":
      return "●";
    case "waiting":
      return "◐";
    default:
      return "○";
  }
}

function formatFactLine(theme: ObservabilityTheme, item: RunFact): string {
  return `${color(theme, "muted", compactTimestamp(item.timestamp))} ${factColor(theme, item.kind)} ${reliability(theme, item.reliability)} ${item.summary}`;
}

function factId(item: RunFact): string {
  return `${item.timestamp}:${item.runId}:${item.kind}:${item.summary}`;
}

function definitionLabel(value: string): string {
  return value.replace(/^(?:agent|workflow|session|root)\./, "");
}

function statusField(label: string, value: string): string {
  return ` ${label.padEnd(12)} ${value}`;
}

function compactTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(11, 19);
}

function shortRunId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function distributeWidths(total: number, count: number): readonly number[] {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function centerToWidth(value: string, width: number): string {
  const clipped = fitViewLine(value, width).trimEnd();
  const remaining = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(remaining / 2);
  return fitViewLine(`${" ".repeat(left)}${clipped}`, width);
}

function wrapPane(value: number, delta: number, count: number): UiPane {
  return ((value + delta + count) % count) as UiPane;
}

function fitHeight(lines: readonly string[], height: number, width: number): string[] {
  return Array.from({ length: height }, (_, row) => fitViewLine(lines[row] ?? "", width));
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function isUp(data: string): boolean {
  return matchesKey(data, "up") || data === "k" || data === "K";
}

function isDown(data: string): boolean {
  return matchesKey(data, "down") || data === "j" || data === "J";
}

function isLeft(data: string): boolean {
  return matchesKey(data, "left") || data === "h" || data === "H";
}

function isRight(data: string): boolean {
  return matchesKey(data, "right") || data === "l" || data === "L";
}
