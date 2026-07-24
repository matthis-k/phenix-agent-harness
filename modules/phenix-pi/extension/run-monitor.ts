import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { RunTree, RunTreeNode } from "../application/interfaces.ts";
import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import type { DiagnosticSummary } from "../domain/diagnostics.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import type { RunFact } from "../domain/run/observability.ts";
import type { RunId } from "../domain/shared.ts";
import {
  color,
  fact,
  heading,
  type ObservabilityTheme,
  phase,
  reliability,
  state,
  strong,
} from "./observability-theme.ts";

const WIDGET_KEY = "phenix-live-status";
const MAX_FACT_LINES = 24;
const DASHBOARD_FACT_LINES = 3;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);
const STATE_SYMBOLS: Readonly<Record<string, string>> = {
  completed: "✓",
  failed: "✗",
  orphaned: "✗",
  cancelled: "−",
  waiting: "○",
};
const RELIABILITY_SYMBOLS: Readonly<Record<RunFact["reliability"], string>> = {
  observed: "✓",
  derived: "≈",
  reported: "!",
};

export type RunMonitorMode = "hidden" | "status" | "facts";

export interface FactHistoryExport {
  readonly text: string;
  readonly count: number;
}

export interface RunMonitorOptions {
  readonly integrations?: string;
  readonly integrationsFailed?: boolean;
}

interface DashboardData {
  readonly tree: RunTree;
  readonly facts: readonly RunFact[];
  readonly sequence: number;
  readonly profile: SessionProfile;
  readonly diagnostics: DiagnosticSummary;
  readonly integrations: string;
  readonly integrationsFailed: boolean;
  readonly expanded: boolean;
}

interface DescendantStats {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly active: number;
}

export class RunMonitor {
  private readonly ctx: ExtensionContext;
  private readonly runtime: PhenixRuntime;
  private readonly rootRunId: RunId;
  private readonly options: RunMonitorOptions;
  private mode: RunMonitorMode = "hidden";
  private expanded = false;
  private refreshing = false;
  private pending = false;
  private disposed = false;

  constructor(
    ctx: ExtensionContext,
    runtime: PhenixRuntime,
    rootRunId: RunId,
    options: RunMonitorOptions = {},
  ) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.rootRunId = rootRunId;
    this.options = options;
  }

  get currentMode(): RunMonitorMode {
    return this.mode;
  }

  async show(
    mode: Exclude<RunMonitorMode, "hidden">,
    options: { readonly expanded?: boolean } = {},
  ): Promise<void> {
    if (this.disposed) return;
    this.mode = mode;
    if (options.expanded !== undefined) this.expanded = options.expanded;
    await this.refresh();
  }

  hide(): void {
    this.mode = "hidden";
    this.ctx.ui.setWidget?.(WIDGET_KEY, undefined);
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.mode === "hidden") return;
    if (this.refreshing) {
      this.pending = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.pending = false;
        const requestedMode: Exclude<RunMonitorMode, "hidden"> = this.mode;
        const lines = await this.render(requestedMode, this.ctx.ui.theme);
        if (!this.disposed && this.mode === requestedMode) {
          this.ctx.ui.setWidget?.(WIDGET_KEY, createUnboundedWidget(lines), {
            placement: "aboveEditor",
          });
        }
      } while (this.pending && !this.disposed);
    } finally {
      this.refreshing = false;
    }
  }

  async once(
    mode: Exclude<RunMonitorMode, "hidden">,
    options: { readonly expanded?: boolean } = {},
  ): Promise<string> {
    const previous = this.expanded;
    if (options.expanded !== undefined) this.expanded = options.expanded;
    try {
      return (await this.render(mode, this.ctx.ui.theme)).join("\n");
    } finally {
      this.expanded = previous;
    }
  }

  async json(mode: Exclude<RunMonitorMode, "hidden">): Promise<string> {
    if (mode === "facts") {
      return JSON.stringify(await this.runtime.queries.facts(this.rootRunId), null, 2);
    }
    const data = await this.dashboardData();
    return JSON.stringify(
      {
        sequence: data.sequence,
        profile: data.profile,
        tree: data.tree,
        facts: selectRecentFacts(data.facts),
        diagnostics: data.diagnostics,
        storage: {
          ledger: this.runtime.ledgerPath(this.rootRunId) ?? "in-memory",
          logs: this.runtime.diagnostics.pathFor(this.rootRunId) ?? "in-memory",
          artifacts: this.runtime.diagnostics.artifactDirectoryFor(this.rootRunId) ?? "in-memory",
        },
        integrations: data.integrations,
      },
      null,
      2,
    );
  }

  async exportFacts(): Promise<FactHistoryExport> {
    const facts = await this.runtime.queries.facts(this.rootRunId);
    return {
      text: renderCompleteFactHistory(facts, this.runtime.sequence(this.rootRunId)),
      count: facts.length,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.hide();
  }

  private async render(
    mode: Exclude<RunMonitorMode, "hidden">,
    theme?: ObservabilityTheme,
  ): Promise<string[]> {
    if (mode === "facts") {
      const facts = await this.runtime.queries.facts(this.rootRunId, MAX_FACT_LINES);
      return renderFacts(facts, this.runtime.sequence(this.rootRunId), theme);
    }
    return renderDashboard(await this.dashboardData(), theme);
  }

  private async dashboardData(): Promise<DashboardData> {
    const [tree, facts, profile, diagnostics] = await Promise.all([
      this.runtime.queries.runTree(this.rootRunId),
      this.runtime.queries.facts(this.rootRunId, MAX_FACT_LINES),
      this.runtime.profiles.current(this.rootRunId),
      this.runtime.diagnostics.summary(this.rootRunId),
    ]);
    return {
      tree,
      facts,
      sequence: this.runtime.sequence(this.rootRunId),
      profile,
      diagnostics,
      integrations: this.options.integrations ?? "unknown",
      integrationsFailed: this.options.integrationsFailed ?? false,
      expanded: this.expanded,
    };
  }
}

export function createUnboundedWidget(lines: readonly string[]): () => Text {
  const content = lines.join("\n");
  return () => new Text(content, 1, 0);
}

export function renderDashboard(data: DashboardData, theme?: ObservabilityTheme): string[] {
  const activeDescendants = countNodes(
    data.tree.root,
    (node) => node.run.id !== data.tree.root.run.id && !isTerminal(node.run.state),
  );
  const lines = [dashboardHeader(data, activeDescendants, theme), ""];
  if (data.tree.root.children.length === 0) {
    lines.push(color(theme, "success", "idle"));
  } else {
    data.tree.root.children.forEach((child, index) => {
      appendNode(
        lines,
        child,
        "",
        index === data.tree.root.children.length - 1,
        theme,
        data.expanded,
      );
    });
  }

  const recentFacts = selectRecentFacts(data.facts);
  if (recentFacts.length > 0) {
    lines.push("", heading(theme, "Recent facts"));
    for (const factItem of recentFacts) {
      lines.push(`  ${formatFact(factItem, true, theme)}`);
    }
  }

  lines.push(
    "",
    color(
      theme,
      "dim",
      data.expanded
        ? "/phenix status off · /phenix status · /phenix facts · /phenix logs"
        : "/phenix status off · /phenix status --expanded · /phenix facts · /phenix logs",
    ),
  );
  return lines;
}

export function renderFacts(
  facts: readonly RunFact[],
  sequence: number,
  theme?: ObservabilityTheme,
): string[] {
  const lines = [heading(theme, `Phenix fact history · seq ${sequence}`)];
  if (facts.length === 0) lines.push(color(theme, "muted", "No facts recorded yet."));
  for (const factItem of facts.slice(-MAX_FACT_LINES)) {
    lines.push(formatFact(factItem, true, theme));
  }
  lines.push("", color(theme, "dim", "/phenix facts off · /phenix status"));
  return lines;
}

export function renderCompleteFactHistory(facts: readonly RunFact[], sequence: number): string {
  const lines = [`Phenix fact history · seq ${sequence}`];
  if (facts.length === 0) lines.push("No facts recorded yet.");
  for (const factItem of facts) lines.push(formatFact(factItem, false));
  return `${lines.join("\n")}\n`;
}

function dashboardHeader(
  data: DashboardData,
  activeDescendants: number,
  theme: ObservabilityTheme | undefined,
): string {
  const parts = [
    heading(theme, `Phenix status · seq ${data.sequence}`),
    `${strong(theme, data.profile.agent)}${color(theme, "dim", " · ")}${color(
      theme,
      "muted",
      `${data.profile.modelSet} · ${data.profile.difficulty}`,
    )}`,
    color(
      theme,
      activeDescendants === 0 ? "success" : "warning",
      activeDescendants === 0 ? "idle" : `${activeDescendants} active`,
    ),
  ];
  if (data.diagnostics.counts.error > 0) {
    parts.push(color(theme, "error", `${data.diagnostics.counts.error} errors`));
  } else if (data.diagnostics.counts.warning > 0) {
    parts.push(color(theme, "warning", `${data.diagnostics.counts.warning} warnings`));
  }
  parts.push(color(theme, data.integrationsFailed ? "error" : "muted", data.integrations));
  return parts.join(color(theme, "dim", "  ·  "));
}

function appendNode(
  lines: string[],
  node: RunTreeNode,
  prefix: string,
  last: boolean,
  theme: ObservabilityTheme | undefined,
  expanded: boolean,
): void {
  const branch = last ? "└─ " : "├─ ";
  const symbol = state(theme, node.run.state, stateSymbol(node.run.state));
  const label = strong(theme, definitionLabel(String(node.run.definitionId)));
  const stateLabel = state(theme, node.run.state, `[${node.run.state}]`);
  const collapsed = node.run.state === "completed" && node.children.length > 0 && !expanded;
  const details = [modelDetails(node, theme)];
  if (collapsed) details.push(collapsedDetails(node, theme));
  if (!isTerminal(node.run.state) && node.activity) details.push(activityDetails(node, theme));
  const suffix = details.filter(Boolean).join(color(theme, "dim", "  ·  "));
  lines.push(
    `${color(theme, "dim", `${prefix}${branch}`)}${symbol} ${label} ${stateLabel}${
      suffix ? `  ${suffix}` : ""
    }`,
  );
  if (collapsed) return;
  const childPrefix = `${prefix}${last ? "   " : "│  "}`;
  node.children.forEach((child, index) => {
    appendNode(lines, child, childPrefix, index === node.children.length - 1, theme, expanded);
  });
}

function modelDetails(node: RunTreeNode, theme: ObservabilityTheme | undefined): string {
  if (!node.run.resolvedModel) return "";
  const model = node.run.resolvedModel;
  return color(
    theme,
    "muted",
    `${model.concrete.provider}/${model.concrete.model} · ${model.thinking}`,
  );
}

function collapsedDetails(node: RunTreeNode, theme: ObservabilityTheme | undefined): string {
  const stats = descendantStats(node);
  const parts: string[] = [];
  if (stats.completed > 0) parts.push(`${stats.completed} children completed`);
  if (stats.failed > 0) parts.push(`${stats.failed} failed`);
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled`);
  if (stats.active > 0) parts.push(`${stats.active} active`);
  if (parts.length === 0) parts.push(`${stats.total} children`);
  return color(theme, stats.failed > 0 ? "error" : "success", parts.join(" · "));
}

function activityDetails(node: RunTreeNode, theme: ObservabilityTheme | undefined): string {
  if (!node.activity) return "";
  const reported = node.activity.source === "reported" ? `${color(theme, "warning", "!")} ` : "";
  const target = node.activity.target
    ? `${color(theme, "dim", " → ")}${color(theme, "muted", truncate(node.activity.target, 48))}`
    : "";
  return `${reported}${phase(theme, node.activity.phase, node.activity.phase)}${color(
    theme,
    "dim",
    " ",
  )}${color(theme, "text", truncate(node.activity.summary, 56))}${target}`;
}

function formatFact(factItem: RunFact, compact = true, theme?: ObservabilityTheme): string {
  const time =
    factItem.timestamp.length >= 19 ? factItem.timestamp.slice(11, 19) : factItem.timestamp;
  const run = shortRunId(factItem.runId);
  const summary = compact ? truncate(factItem.summary, 100) : normalize(factItem.summary);
  const subject = factItem.subject
    ? `${color(theme, "dim", " · ")}${color(
        theme,
        "muted",
        compact ? truncate(factItem.subject, 64) : normalize(factItem.subject),
      )}`
    : "";
  return `${color(theme, "dim", time)} ${reliability(
    theme,
    factItem.reliability,
    RELIABILITY_SYMBOLS[factItem.reliability],
  )} ${color(theme, "muted", run)}${color(theme, "dim", " · ")}${fact(
    theme,
    factItem.kind,
    summary,
    summary,
  )}${subject}`;
}

function selectRecentFacts(facts: readonly RunFact[]): readonly RunFact[] {
  const selected: RunFact[] = [];
  const seen = new Set<string>();
  for (const item of [...facts].reverse()) {
    const key = `${item.kind}\u0000${normalize(item.summary)}\u0000${normalize(item.subject ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
    if (selected.length >= DASHBOARD_FACT_LINES) break;
  }
  return selected.reverse();
}

function countNodes(node: RunTreeNode, predicate: (node: RunTreeNode) => boolean): number {
  return (
    (predicate(node) ? 1 : 0) +
    node.children.reduce((total, child) => total + countNodes(child, predicate), 0)
  );
}

function descendantStats(node: RunTreeNode): DescendantStats {
  let total = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let active = 0;
  const visit = (current: RunTreeNode): void => {
    for (const child of current.children) {
      total += 1;
      if (child.run.state === "completed") completed += 1;
      else if (child.run.state === "failed" || child.run.state === "orphaned") failed += 1;
      else if (child.run.state === "cancelled") cancelled += 1;
      else active += 1;
      visit(child);
    }
  };
  visit(node);
  return { total, completed, failed, cancelled, active };
}

function definitionLabel(value: string): string {
  return value.replace(/^(?:agent|workflow)\./, "");
}

function shortRunId(value: RunId): string {
  const text = String(value);
  const parts = text.split("-");
  return truncate(parts.length > 2 ? parts.slice(0, 2).join("-") : text, 24);
}

function stateSymbol(value: string): string {
  return STATE_SYMBOLS[value] ?? "●";
}

function isTerminal(value: string): boolean {
  return TERMINAL_STATES.has(value);
}

function normalize(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  const normalized = normalize(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
