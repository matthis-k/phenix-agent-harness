import {
  type Component,
  Container,
  matchesKey,
  sliceByColumn,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { RunTree, RunTreeNode } from "../application/interfaces.ts";
import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import { type AnyDefinition, definitionRef } from "../domain/definition/definition.ts";
import type { DiagnosticSummary } from "../domain/diagnostics.ts";
import type { RunSnapshot, SessionProfile } from "../domain/run/model.ts";
import type { RunFact } from "../domain/run/observability.ts";
import type { RunId } from "../domain/shared.ts";
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

interface FlatRun {
  readonly node: RunTreeNode;
  readonly depth: number;
}

interface MouseEvent {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
}

interface RowHit {
  readonly view: PhenixUiView;
  readonly index: number;
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
  private selectedStatus = 0;
  private selectedRunId: string;
  private selectedFact = 0;
  private selectedDefinition = 0;
  private readonly collapsedRuns = new Set<string>();
  private readonly manuallyExpandedRuns = new Set<string>();
  private runViewerMode: RunViewerMode = "diagram";
  private runHorizontalOffset = 0;
  private runVerticalOffset = 0;
  private runTranscriptOffset = Number.MAX_SAFE_INTEGER;
  private runInspectorOffset = 0;
  private readonly transcriptCache = new Map<string, NativeRunTranscript>();
  private readonly transcriptLoading = new Set<string>();
  private factDetailOffset = 0;
  private catalogHorizontalOffset = 0;
  private catalogVerticalOffset = 0;
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
    this.selectedRunId = String(options.snapshot.tree.root.run.id);
    this.initializeCollapsedRuns(options.snapshot.tree.root);
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
      this.fitLine(`${title}${" ".repeat(gap)}${status}`, width),
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
    return this.fitLine(segments.join(""), width);
  }

  private selectedRow(text: string, pane: UiPane, width: number): string {
    const line = this.fitLine(`  ${text}`, width);
    return surface(
      this.theme,
      this.pane === pane ? "selectedBg" : "userMessageBg",
      this.pane === pane ? strong(this.theme, line) : line,
    );
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
    const runs = this.statusRuns();
    const facts = this.filteredFacts().slice(-5);
    const targets = this.statusTargets();
    this.selectedStatus = clamp(this.selectedStatus, 0, Math.max(0, targets.length - 1));
    const lines = [
      heading(this.theme, " Session"),
      ` ${coloredStatusField(this.theme, "agent", this.snapshot.profile.agent, "text")}  ${coloredStatusField(this.theme, "model", this.snapshot.profile.modelSet, "accent")}  ${coloredStatusField(this.theme, "difficulty", this.snapshot.profile.difficulty, "warning")}  ${coloredStatusField(this.theme, "integrations", this.snapshot.integrations, "success")}`,
      ` ${coloredStatusField(this.theme, "sequence", String(this.snapshot.sequence), "accent")}  ${coloredStatusField(this.theme, "diagnostics", `${this.snapshot.diagnostics.counts.warning} warning / ${this.snapshot.diagnostics.counts.error} error`, this.snapshot.diagnostics.counts.error > 0 ? "error" : this.snapshot.diagnostics.counts.warning > 0 ? "warning" : "success")}`,
      "",
      heading(this.theme, " Active execution"),
    ];
    if (runs.length === 0) lines.push(` ${color(this.theme, "success", "✓ idle")}`);
    runs.forEach((run, index) => {
      const selected = index === this.selectedStatus;
      const line = runSummary(this.theme, run.node, run.depth);
      lines.push(selected ? this.selectedRow(line, 0, width) : `  ${line}`);
      this.rowHits.set(this.layout.bodyStart + lines.length - 1, {
        view: "status",
        index,
        pane: 0,
      });
    });
    lines.push("", heading(this.theme, " Recent facts"));
    facts.forEach((fact, index) => {
      const targetIndex = runs.length + index;
      const selected = targetIndex === this.selectedStatus;
      const line = formatFactLine(this.theme, fact);
      lines.push(selected ? this.selectedRow(line, 0, width) : `  ${line}`);
      this.rowHits.set(this.layout.bodyStart + lines.length - 1, {
        view: "status",
        index: targetIndex,
        pane: 0,
      });
    });
    if (facts.length === 0) lines.push(` ${color(this.theme, "muted", "No facts recorded yet.")}`);
    return lines.map((line) => this.fitLine(line, width));
  }

  private renderRuns(): string[] {
    const width = this.layout.width;
    const height = this.layout.bodyHeight;
    const flat = this.filteredRuns();
    this.ensureSelectedRun(flat);
    const selectedIndex = Math.max(
      0,
      flat.findIndex((item) => String(item.node.run.id) === this.selectedRunId),
    );
    const selected = flat[selectedIndex]?.node ?? this.snapshot.tree.root;
    if (width < 82) {
      return this.pane === 0
        ? this.renderRunTreePane(flat, selectedIndex, width, height)
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
    const tree = this.renderRunTreePane(flat, selectedIndex, treeWidth, height);
    const preview = this.renderRunViewerPane(selected, previewWidth, height);
    const inspector =
      inspectorWidth > 0 ? this.renderRunInspectorPane(selected, inspectorWidth, height) : [];
    return Array.from({ length: height }, (_, row) => {
      const left = this.panelLine(tree[row] ?? "", treeWidth, 0);
      const middle =
        this.runViewerMode === "transcript"
          ? this.fitLine(preview[row] ?? "", previewWidth)
          : this.panelLine(preview[row] ?? "", previewWidth, 1);
      if (inspectorWidth === 0) return `${left} ${middle}`;
      const right = this.panelLine(inspector[row] ?? "", inspectorWidth, 2);
      return `${left} ${middle} ${right}`;
    });
  }

  private renderRunTreePane(
    flat: readonly FlatRun[],
    selectedIndex: number,
    width: number,
    height: number,
  ): string[] {
    const start = centeredStart(selectedIndex, height, flat.length);
    return Array.from({ length: height }, (_, row) => {
      const index = start + row;
      const item = flat[index];
      if (!item) return " ".repeat(width);
      const run = item.node.run;
      const selected = index === selectedIndex;
      const hasChildren = item.node.children.length > 0;
      const collapsed = this.collapsedRuns.has(String(run.id));
      const disclosure = hasChildren ? (collapsed ? "▸" : "▾") : " ";
      const symbol = state(this.theme, run.state, runStateSymbol(run.state));
      const model = run.resolvedModel
        ? ` ${color(this.theme, "muted", `${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`)}`
        : "";
      const text = `${"  ".repeat(item.depth)}${disclosure} ${symbol} ${strong(this.theme, definitionLabel(String(run.definitionId)))} ${state(this.theme, run.state, run.state)}${model}`;
      this.rowHits.set(this.layout.bodyStart + row, { view: "runs", index, pane: 0 });
      return this.fitLine(selected ? this.selectedRow(text, 0, width) : `  ${text}`, width);
    });
  }

  private renderRunViewerPane(node: RunTreeNode, width: number, height: number): string[] {
    return this.runViewerMode === "diagram"
      ? this.renderRunDiagramPane(node, width, height)
      : this.renderRunTranscriptPane(node, width, height);
  }

  private renderRunDiagramPane(node: RunTreeNode, width: number, height: number): string[] {
    const lines = this.runPreviewLines(node);
    const maxX = Math.max(0, maxVisibleWidth(lines) - width);
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
    } else {
      lines.push(...transcript.component.render(width));
    }
    const maxY = Math.max(0, lines.length - height);
    this.runTranscriptOffset = clamp(this.runTranscriptOffset, 0, maxY);
    return Array.from({ length: height }, (_, row) =>
      this.fitLine(lines[this.runTranscriptOffset + row] ?? "", width),
    );
  }

  private renderRunInspectorPane(node: RunTreeNode, width: number, height: number): string[] {
    const run = node.run;
    const model = run.resolvedModel;
    const facts = this.snapshot.facts.filter((item) => item.runId === run.id).slice(-5);
    const lines = [
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
    ];
    const maxY = Math.max(0, lines.length - height);
    this.runInspectorOffset = clamp(this.runInspectorOffset, 0, maxY);
    return Array.from({ length: height }, (_, row) =>
      this.fitLine(lines[this.runInspectorOffset + row] ?? "", width),
    );
  }

  private renderFacts(): string[] {
    const width = this.layout.width;
    const height = this.layout.bodyHeight;
    const facts = this.filteredFacts();
    this.selectedFact = clamp(this.selectedFact, 0, Math.max(0, facts.length - 1));
    if (width < 76) {
      return this.pane === 0
        ? this.renderFactList(facts, width, height)
        : this.renderFactDetail(facts[this.selectedFact], width, height);
    }
    const listWidth = Math.min(68, Math.max(38, Math.floor(width * 0.55)));
    const detailWidth = width - listWidth - 1;
    const list = this.renderFactList(facts, listWidth, height);
    const detail = this.renderFactDetail(facts[this.selectedFact], detailWidth, height);
    return Array.from(
      { length: height },
      (_, row) =>
        `${this.panelLine(list[row] ?? "", listWidth, 0)} ${this.panelLine(detail[row] ?? "", detailWidth, 1)}`,
    );
  }

  private renderFactList(facts: readonly RunFact[], width: number, height: number): string[] {
    const start = centeredStart(this.selectedFact, height, facts.length);
    return Array.from({ length: height }, (_, row) => {
      const index = start + row;
      const item = facts[index];
      if (!item) return " ".repeat(width);
      const selected = index === this.selectedFact;
      this.rowHits.set(this.layout.bodyStart + row, { view: "facts", index, pane: 0 });
      const line = formatFactLine(this.theme, item);
      return this.fitLine(selected ? this.selectedRow(line, 0, width) : `  ${line}`, width);
    });
  }

  private renderFactDetail(item: RunFact | undefined, width: number, height: number): string[] {
    const lines = item
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
      : [heading(this.theme, " Fact detail"), color(this.theme, "muted", "No facts recorded.")];
    const maxY = Math.max(0, lines.length - height);
    this.factDetailOffset = clamp(this.factDetailOffset, 0, maxY);
    return Array.from({ length: height }, (_, row) =>
      this.fitLine(lines[this.factDetailOffset + row] ?? "", width),
    );
  }

  private renderCatalog(): string[] {
    const width = this.layout.width;
    const height = this.layout.bodyHeight;
    const definitions = this.filteredDefinitions();
    this.selectedDefinition = clamp(
      this.selectedDefinition,
      0,
      Math.max(0, definitions.length - 1),
    );
    const selected = definitions[this.selectedDefinition];
    if (width < 76) {
      return this.pane === 0
        ? this.renderDefinitionSidebar(definitions, selected, width, height)
        : this.renderDefinitionPreview(selected, width, height);
    }
    const sidebarWidth = this.layout.sidebarWidth;
    const previewWidth = width - sidebarWidth - 1;
    const sidebar = this.renderDefinitionSidebar(definitions, selected, sidebarWidth, height);
    const preview = this.renderDefinitionPreview(selected, previewWidth, height);
    return Array.from(
      { length: height },
      (_, row) =>
        `${sidebar[row] ?? " ".repeat(sidebarWidth)} ${this.panelLine(preview[row] ?? "", previewWidth, 1)}`,
    );
  }

  private renderDefinitionSidebar(
    definitions: readonly AnyDefinition[],
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
    const list = this.renderDefinitionList(definitions, width, listHeight).map((line) =>
      this.panelLine(line, width, 0),
    );
    const inspector = this.definitionInspectorLines(selected, width);
    const details = Array.from({ length: inspectorHeight }, (_, row) =>
      surface(this.theme, "customMessageBg", this.fitLine(inspector[row] ?? "", width)),
    );
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

  private renderDefinitionList(
    definitions: readonly AnyDefinition[],
    width: number,
    height: number,
  ): string[] {
    const start = centeredStart(this.selectedDefinition, height, definitions.length);
    return Array.from({ length: height }, (_, row) => {
      const index = start + row;
      const item = definitions[index];
      if (!item) return " ".repeat(width);
      const selected = index === this.selectedDefinition;
      const kind =
        item.kind === "workflow"
          ? color(this.theme, "accent", "W")
          : color(this.theme, "success", "A");
      const text = `${kind} ${strong(this.theme, definitionLabel(String(item.id)))}`;
      this.rowHits.set(this.layout.bodyStart + row, { view: "catalog", index, pane: 0 });
      return this.fitLine(selected ? this.selectedRow(text, 0, width) : `  ${text}`, width);
    });
  }

  private renderDefinitionPreview(
    definition: AnyDefinition | undefined,
    width: number,
    height: number,
  ): string[] {
    const lines = this.catalogPreviewLines(definition);
    const maxX = Math.max(0, maxVisibleWidth(lines) - width);
    const maxY = Math.max(0, lines.length - height);
    this.catalogHorizontalOffset = clamp(this.catalogHorizontalOffset, 0, maxX);
    this.catalogVerticalOffset = clamp(this.catalogVerticalOffset, 0, maxY);
    return Array.from({ length: height }, (_, row) => {
      const source = lines[this.catalogVerticalOffset + row] ?? "";
      return this.fitLine(sliceByColumn(source, this.catalogHorizontalOffset, width, true), width);
    });
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
    return fitHeight(
      lines.map((line) => this.fitLine(line, width)),
      height,
      width,
    );
  }

  private renderSmall(width: number, height: number): string[] {
    const lines = [
      heading(this.theme, " Phenix UI"),
      color(this.theme, "warning", " Terminal is too small for the full-screen interface."),
      " Resize to at least 42 columns and 8 rows.",
      " Esc closes the UI.",
    ];
    return fitHeight(
      lines.map((line) => this.fitLine(line, width)),
      height,
      width,
    );
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
      this.fitLine(color(this.theme, "muted", text), width),
    );
  }

  private handleStatusInput(data: string): void {
    const targets = this.statusTargets();
    if (isUp(data)) this.selectedStatus = clamp(this.selectedStatus - 1, 0, targets.length - 1);
    else if (isDown(data))
      this.selectedStatus = clamp(this.selectedStatus + 1, 0, targets.length - 1);
    else if (matchesKey(data, "enter")) this.openStatusTarget(targets[this.selectedStatus]);
    else return;
    this.requestRender();
  }

  private handleRunsInput(data: string): void {
    const flat = this.filteredRuns();
    this.ensureSelectedRun(flat);
    let index = Math.max(
      0,
      flat.findIndex((item) => String(item.node.run.id) === this.selectedRunId),
    );
    const selected = flat[index];
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
        if (selected.node.children.length && this.collapsedRuns.has(String(selected.node.run.id))) {
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
        if (
          selected.node.children.length &&
          !this.collapsedRuns.has(String(selected.node.run.id))
        ) {
          this.collapsedRuns.add(String(selected.node.run.id));
        } else {
          const parent = parentOf(this.snapshot.tree.root, selected.node.run.id);
          if (parent) this.selectedRunId = String(parent.run.id);
        }
      } else return;
      const next = flat[clamp(index, 0, Math.max(0, flat.length - 1))];
      if (next) this.selectRun(next.node);
      this.requestRender();
      return;
    }
    if (this.pane === 1) {
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
    if (isUp(data)) this.runInspectorOffset = Math.max(0, this.runInspectorOffset - 1);
    else if (isDown(data)) this.runInspectorOffset += 1;
    else if (matchesKey(data, "pageUp"))
      this.runInspectorOffset = Math.max(0, this.runInspectorOffset - this.layout.bodyHeight + 2);
    else if (matchesKey(data, "pageDown")) this.runInspectorOffset += this.layout.bodyHeight - 2;
    else return;
    this.requestRender();
  }

  private handleFactsInput(data: string): void {
    const facts = this.filteredFacts();
    if (this.pane === 0) {
      if (isUp(data)) this.selectedFact -= 1;
      else if (isDown(data)) this.selectedFact += 1;
      else if (matchesKey(data, "home")) this.selectedFact = 0;
      else if (matchesKey(data, "end")) this.selectedFact = facts.length - 1;
      else if (matchesKey(data, "enter") || matchesKey(data, "right")) this.pane = 1;
      else return;
      this.selectedFact = clamp(this.selectedFact, 0, Math.max(0, facts.length - 1));
      this.factDetailOffset = 0;
    } else if (isUp(data)) this.factDetailOffset = Math.max(0, this.factDetailOffset - 1);
    else if (isDown(data)) this.factDetailOffset += 1;
    else if (matchesKey(data, "left")) this.pane = 0;
    else return;
    this.requestRender();
  }

  private handleCatalogInput(data: string): void {
    const definitions = this.filteredDefinitions();
    if (this.pane === 0) {
      if (isUp(data)) this.selectedDefinition -= 1;
      else if (isDown(data)) this.selectedDefinition += 1;
      else if (matchesKey(data, "home")) this.selectedDefinition = 0;
      else if (matchesKey(data, "end")) this.selectedDefinition = definitions.length - 1;
      else if (matchesKey(data, "enter") || matchesKey(data, "right")) this.pane = 1;
      else return;
      this.selectedDefinition = clamp(
        this.selectedDefinition,
        0,
        Math.max(0, definitions.length - 1),
      );
      this.catalogHorizontalOffset = 0;
      this.catalogVerticalOffset = 0;
      this.previewCache = undefined;
    } else if (isLeft(data))
      this.catalogHorizontalOffset = Math.max(0, this.catalogHorizontalOffset - 4);
    else if (isRight(data)) this.catalogHorizontalOffset += 4;
    else if (isUp(data)) this.catalogVerticalOffset = Math.max(0, this.catalogVerticalOffset - 1);
    else if (isDown(data)) this.catalogVerticalOffset += 1;
    else if (matchesKey(data, "pageUp"))
      this.catalogVerticalOffset = Math.max(
        0,
        this.catalogVerticalOffset - this.layout.bodyHeight + 2,
      );
    else if (matchesKey(data, "pageDown")) this.catalogVerticalOffset += this.layout.bodyHeight - 2;
    else if (matchesKey(data, "home")) this.catalogHorizontalOffset = 0;
    else if (matchesKey(data, "end")) this.catalogHorizontalOffset = Number.MAX_SAFE_INTEGER;
    else return;
    this.requestRender();
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
      this.selectedStatus = hit.index;
      this.openStatusTarget(this.statusTargets()[hit.index]);
    } else if (hit.view === "runs") {
      const run = this.filteredRuns()[hit.index];
      if (run) this.selectRun(run.node);
    } else if (hit.view === "facts") {
      this.selectedFact = hit.index;
    } else if (hit.view === "catalog") {
      this.selectedDefinition = hit.index;
      this.catalogHorizontalOffset = 0;
      this.catalogVerticalOffset = 0;
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

  private statusRuns(): readonly FlatRun[] {
    return flattenRuns(this.snapshot.tree.root, new Set())
      .filter((item) => item.node.run.id !== this.snapshot.tree.root.run.id)
      .filter((item) => !TERMINAL_STATES.has(item.node.run.state))
      .slice(0, Math.max(3, Math.floor(this.layout.bodyHeight / 2) - 4));
  }

  private statusTargets(): readonly (
    | { readonly kind: "run"; readonly item: FlatRun }
    | { readonly kind: "fact"; readonly item: RunFact }
  )[] {
    const runs = this.statusRuns();
    const facts = this.filteredFacts().slice(-5);
    return [
      ...runs.map((item) => ({ kind: "run" as const, item })),
      ...facts.map((item) => ({ kind: "fact" as const, item })),
    ];
  }

  private openStatusTarget(
    target:
      | { readonly kind: "run"; readonly item: FlatRun }
      | { readonly kind: "fact"; readonly item: RunFact }
      | undefined,
  ): void {
    if (!target) return;
    if (target.kind === "run") {
      this.selectRun(target.item.node);
      this.runViewerMode = target.item.node.run.pi?.sessionFile ? "transcript" : "diagram";
      this.pane = 1;
      if (this.runViewerMode === "transcript") void this.ensureRunTranscript(target.item.node);
      this.switchView("runs");
      return;
    }
    const index = this.filteredFacts().indexOf(target.item);
    this.selectedFact = Math.max(0, index);
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

  private filteredRuns(): readonly FlatRun[] {
    const normalized = this.filter.toLowerCase();
    return flattenRuns(this.snapshot.tree.root, this.collapsedRuns).filter((item) => {
      if (!normalized) return true;
      const run = item.node.run;
      const model = run.resolvedModel;
      return [
        run.id,
        run.definitionId,
        run.state,
        run.kind,
        model?.concrete.provider,
        model?.concrete.model,
        model?.thinking,
        item.node.activity?.summary,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized));
    });
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

  private initializeCollapsedRuns(node: RunTreeNode): void {
    const id = String(node.run.id);
    if (
      node.run.kind === "workflow" &&
      TERMINAL_STATES.has(node.run.state) &&
      !this.manuallyExpandedRuns.has(id)
    ) {
      this.collapsedRuns.add(id);
    }
    node.children.forEach((child) => {
      this.initializeCollapsedRuns(child);
    });
  }

  private applyInitialSelector(selector: string | undefined): void {
    if (!selector) return;
    if (this.view === "runs") {
      const normalized = selector.toLowerCase();
      const match = flattenRuns(this.snapshot.tree.root, new Set()).find((item) => {
        const id = String(item.node.run.id).toLowerCase();
        return id === normalized || id.endsWith(normalized);
      });
      if (match) this.selectedRunId = String(match.node.run.id);
      return;
    }
    if (this.view === "catalog") {
      const normalized = selector.toLowerCase();
      const definitions = this.filteredDefinitions();
      const index = definitions.findIndex((item) => {
        const id = String(item.id).toLowerCase();
        return (
          id === normalized ||
          id.replace(/^(?:agent|workflow)\./, "") === normalized ||
          item.title.toLowerCase() === normalized
        );
      });
      if (index >= 0) this.selectedDefinition = index;
    }
  }

  private ensureSelectedRun(flat: readonly FlatRun[]): void {
    if (flat.some((item) => String(item.node.run.id) === this.selectedRunId)) return;
    this.selectedRunId = String(flat[0]?.node.run.id ?? this.snapshot.tree.root.run.id);
  }

  private selectRun(node: RunTreeNode): void {
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

  private toggleRun(node: RunTreeNode): void {
    if (node.children.length === 0) return;
    const id = String(node.run.id);
    if (this.collapsedRuns.has(id)) {
      this.collapsedRuns.delete(id);
      this.manuallyExpandedRuns.add(id);
    } else {
      this.collapsedRuns.add(id);
      this.manuallyExpandedRuns.delete(id);
    }
  }

  private resetSelectionForFilter(): void {
    switch (this.view) {
      case "status":
        this.selectedStatus = 0;
        break;
      case "runs":
        this.runHorizontalOffset = 0;
        this.runVerticalOffset = 0;
        break;
      case "facts":
        this.selectedFact = 0;
        this.factDetailOffset = 0;
        break;
      case "catalog":
        this.selectedDefinition = 0;
        this.catalogHorizontalOffset = 0;
        this.catalogVerticalOffset = 0;
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
        this.initializeCollapsedRuns(snapshot.tree.root);
        this.previewCache = undefined;
        if (this.view === "runs" && this.runViewerMode === "transcript") {
          const selected = flattenRuns(snapshot.tree.root, new Set()).find(
            (item) => String(item.node.run.id) === this.selectedRunId,
          );
          if (selected) void this.ensureRunTranscript(selected.node, true);
        }
        this.requestRender();
      } while (this.pendingRefresh && !this.disposed);
    } finally {
      this.refreshing = false;
    }
  }

  private panelLine(line: string, width: number, pane: UiPane): string {
    const fitted = this.fitLine(line, width);
    return this.pane === pane
      ? surface(this.theme, "userMessageBg", fitted)
      : surface(this.theme, "customMessageBg", fitted);
  }

  private fitLine(line: string, width: number): string {
    const clipped = truncateToWidth(line, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}

function flattenRuns(
  node: RunTreeNode,
  collapsed: ReadonlySet<string>,
  depth = 0,
  target: FlatRun[] = [],
): readonly FlatRun[] {
  target.push({ node, depth });
  if (collapsed.has(String(node.run.id))) return target;
  node.children.forEach((child) => {
    flattenRuns(child, collapsed, depth + 1, target);
  });
  return target;
}

function parentOf(root: RunTreeNode, runId: RunId): RunTreeNode | undefined {
  for (const child of root.children) {
    if (child.run.id === runId) return root;
    const nested = parentOf(child, runId);
    if (nested) return nested;
  }
  return undefined;
}

function countActive(node: RunTreeNode): number {
  return (
    (node.run.kind !== "root" && !TERMINAL_STATES.has(node.run.state) ? 1 : 0) +
    node.children.reduce((sum, child) => sum + countActive(child), 0)
  );
}

function runSummary(theme: ObservabilityTheme, node: RunTreeNode, depth: number): string {
  const run = node.run;
  const activity = node.activity
    ? ` ${phase(theme, node.activity.phase, truncate(node.activity.summary, 48))}`
    : "";
  return `${"  ".repeat(depth)}${state(theme, run.state, runStateSymbol(run.state))} ${strong(theme, definitionLabel(String(run.definitionId)))} ${state(theme, run.state, run.state)}${activity}`;
}

function runStateSymbol(value: RunSnapshot["state"]): string {
  if (value === "completed") return "✓";
  if (value === "failed" || value === "orphaned") return "✗";
  if (value === "cancelled") return "−";
  if (value === "waiting") return "○";
  return "●";
}

function formatFactLine(theme: ObservabilityTheme, item: RunFact): string {
  return `${compactTimestamp(item.timestamp)} ${factColor(theme, item.kind, item.summary, item.kind)} ${reliability(theme, item.reliability, `[${item.reliability}]`)} ${item.summary}`;
}

function statusField(label: string, value: string): string {
  return `${label}: ${value}`;
}

function definitionLabel(value: string): string {
  return value.replace(/^(?:agent|workflow|session|root)\./, "");
}

function compactTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function shortRunId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function centeredStart(selected: number, height: number, total: number): number {
  return clamp(selected - Math.floor(height / 2), 0, Math.max(0, total - height));
}

function distributeWidths(width: number, count: number): readonly number[] {
  if (count <= 0) return [];
  const base = Math.floor(width / count);
  const remainder = width % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function centerToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  const remaining = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(remaining / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
}

function maxVisibleWidth(lines: readonly string[]): number {
  return lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
}

function fitHeight(lines: readonly string[], height: number, width: number): string[] {
  return Array.from({ length: height }, (_, row) => {
    const source = lines[row] ?? "";
    const clipped = truncateToWidth(source, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  });
}

function wrapPane(current: UiPane, delta: number, count: number): UiPane {
  return ((current + delta + count) % count) as UiPane;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncate(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), width > 1 ? "…" : "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function isLeft(data: string): boolean {
  return matchesKey(data, "left") || data === "h";
}

function isRight(data: string): boolean {
  return matchesKey(data, "right") || data === "l";
}
