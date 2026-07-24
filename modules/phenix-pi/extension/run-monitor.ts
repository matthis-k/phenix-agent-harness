import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { RunTree, RunTreeNode } from "../application/interfaces.ts";
import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import type { PiThinkingLevel } from "../domain/definition/model.ts";
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

const WIDGET_KEY = "phenix-live-runs";
const MAX_FACT_LINES = 24;
const DASHBOARD_FACT_LINES = 5;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);
const TERMINAL_FACT_KINDS = new Set(["child-finished", "error-observed", "run-state-changed"]);
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
const THINKING_TONES: Readonly<Record<PiThinkingLevel, Parameters<typeof color>[1]>> = {
  off: "muted",
  minimal: "muted",
  low: "success",
  medium: "accent",
  high: "warning",
  xhigh: "error",
  max: "error",
};
const DIFFICULTY_THINKING: Readonly<Record<SessionProfile["difficulty"], PiThinkingLevel>> = {
  D0: "minimal",
  D1: "low",
  D2: "high",
  D3: "xhigh",
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
  readonly ledger: string;
  readonly logs: string;
  readonly artifacts: string;
  readonly integrations: string;
  readonly integrationsFailed: boolean;
  readonly expanded: boolean;
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
        storage: { ledger: data.ledger, logs: data.logs, artifacts: data.artifacts },
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
      this.runtime.queries.facts(this.rootRunId),
      this.runtime.profiles.current(this.rootRunId),
      this.runtime.diagnostics.summary(this.rootRunId),
    ]);
    return {
      tree,
      facts,
      sequence: this.runtime.sequence(this.rootRunId),
      profile,
      diagnostics,
      ledger: this.runtime.ledgerPath(this.rootRunId) ?? "in-memory",
      logs: this.runtime.diagnostics.pathFor(this.rootRunId) ?? "in-memory",
      artifacts: this.runtime.diagnostics.artifactDirectoryFor(this.rootRunId) ?? "in-memory",
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
  const roleByRun = new Map<RunId, string>();
  collectRoles(data.tree.root, roleByRun);
  const terminalFacts = terminalFactMap(data.facts);
  const lines = [heading(theme, `Phenix · live status · seq ${data.sequence}`), ""];

  lines.push(heading(theme, "Session"));
  lines.push(
    `  ${color(theme, "dim", "Profile")}       ${strong(theme, data.profile.agent)}${color(theme, "dim", " · ")}${color(theme, "accent", data.profile.modelSet)}${color(theme, "dim", " · ")}${thinking(theme, DIFFICULTY_THINKING[data.profile.difficulty], data.profile.difficulty)}`,
  );
  lines.push(
    `  ${color(theme, "dim", "Integrations")}  ${color(theme, data.integrationsFailed ? "error" : "success", data.integrations)}`,
  );
  lines.push(
    `  ${color(theme, "dim", "Active")}        ${color(theme, activeDescendants === 0 ? "success" : "warning", `${activeDescendants} descendants`)}`,
  );
  lines.push(
    `  ${color(theme, "dim", "Diagnostics")}   ${color(theme, data.diagnostics.counts.error > 0 ? "error" : "success", `${data.diagnostics.counts.error} errors`)}${color(theme, "dim", " · ")}${color(theme, data.diagnostics.counts.warning > 0 ? "warning" : "muted", `${data.diagnostics.counts.warning} warnings`)}${color(theme, "dim", " · ")}${color(theme, "muted", `${data.diagnostics.total} total`)}`,
  );

  lines.push("", heading(theme, "Execution"));
  appendNode(lines, data.tree.root, "", true, theme, terminalFacts, data.expanded, true);

  const recent = selectRecentFacts(data.facts);
  lines.push("", heading(theme, "Recent facts"));
  if (recent.length === 0) lines.push(color(theme, "muted", "  No facts recorded yet."));
  for (const factItem of recent) {
    lines.push(`  ${formatFact(factItem, true, theme, roleByRun.get(factItem.runId))}`);
  }

  lines.push("", heading(theme, "Storage"));
  lines.push(`  ${color(theme, "dim", "Ledger")}     ${color(theme, "muted", data.ledger)}`);
  lines.push(`  ${color(theme, "dim", "Logs")}       ${color(theme, "muted", data.logs)}`);
  lines.push(
    `  ${color(theme, "dim", "Artifacts")}  ${color(theme, "muted", `${data.diagnostics.artifacts} · ${data.artifacts}`)}`,
  );
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

/** Compatibility renderer retained for existing tests and callers. */
export function renderRuns(
  tree: RunTree,
  facts: readonly RunFact[],
  sequence: number,
  theme?: ObservabilityTheme,
): string[] {
  return renderDashboard(
    {
      tree,
      facts,
      sequence,
      profile: { agent: "base", modelSet: "mixed", difficulty: "D1" },
      diagnostics: {
        total: 0,
        artifacts: 0,
        counts: { trace: 0, info: 0, warning: 0, error: 0 },
      },
      ledger: "in-memory",
      logs: "in-memory",
      artifacts: "in-memory",
      integrations: "unknown",
      integrationsFailed: false,
      expanded: true,
    },
    theme,
  );
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

function appendNode(
  lines: string[],
  node: RunTreeNode,
  prefix: string,
  last: boolean,
  theme: ObservabilityTheme | undefined,
  terminalFacts: ReadonlyMap<RunId, RunFact>,
  expanded: boolean,
  root = false,
): void {
  const branch = root ? "" : last ? "└─ " : "├─ ";
  const symbol = state(theme, node.run.state, stateSymbol(node.run.state));
  const label = strong(theme, definitionLabel(String(node.run.definitionId)));
  const stateLabel = state(theme, node.run.state, `[${node.run.state}]`);
  const collapsed = node.run.kind === "workflow" && node.run.state === "completed" && !expanded;
  const terminal = terminalFacts.get(node.run.id);
  const duration = terminal ? formatDuration(node.run.requestedAt, terminal.timestamp) : undefined;
  const suffix = collapsed
    ? `${color(theme, "dim", " · ")}${color(theme, "muted", `${descendantCount(node)} children`)}${duration ? `${color(theme, "dim", " · ")}${color(theme, "success", duration)}` : ""}`
    : "";
  lines.push(
    `${color(theme, "dim", `${prefix}${branch}`)}${symbol} ${label} ${stateLabel}${suffix}`,
  );
  const contentPrefix = root ? "   " : `${prefix}${last ? "   " : "│  "}`;
  if (collapsed) return;

  const model = modelLabel(node, root);
  if (model) {
    const thinkingLabel = model.thinking
      ? `${color(theme, "dim", " · ")}${thinking(theme, model.thinking, model.thinking)}`
      : "";
    lines.push(
      `${color(theme, "dim", contentPrefix)}${color(theme, "accent", model.text)}${thinkingLabel}`,
    );
  }
  if (node.activity) {
    const target = node.activity.target
      ? `${color(theme, "dim", " · ")}${color(theme, "muted", truncate(node.activity.target, 72))}`
      : "";
    const reported = node.activity.source === "reported" ? color(theme, "warning", "! ") : "";
    lines.push(
      `${color(theme, "dim", contentPrefix)}${reported}${phase(theme, node.activity.phase, node.activity.phase)}${color(theme, "dim", " · ")}${color(theme, "text", truncate(node.activity.summary, 72))}${target}`,
    );
  }

  const childPrefix = root ? "" : contentPrefix;
  node.children.forEach((child, index) => {
    appendNode(
      lines,
      child,
      childPrefix,
      index === node.children.length - 1,
      theme,
      terminalFacts,
      expanded,
    );
  });
}

function modelLabel(
  node: RunTreeNode,
  root: boolean,
): { readonly text: string; readonly thinking?: PiThinkingLevel } | undefined {
  if (node.run.resolvedModel) {
    const model = node.run.resolvedModel;
    return {
      text: `${model.concrete.provider}/${model.concrete.model}`,
      thinking: model.thinking,
    };
  }
  if (!root || !node.run.observedModel) return undefined;
  const observed = node.run.observedModel;
  return {
    text: observed.kind === "session" ? "session" : `${observed.provider}/${observed.model}`,
  };
}

function formatFact(
  factItem: RunFact,
  compact = true,
  theme?: ObservabilityTheme,
  role?: string,
): string {
  const time =
    factItem.timestamp.length >= 19 ? factItem.timestamp.slice(11, 19) : factItem.timestamp;
  const run = role ?? shortRunId(factItem.runId);
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

function terminalFactMap(facts: readonly RunFact[]): ReadonlyMap<RunId, RunFact> {
  return new Map(
    facts.filter((item) => TERMINAL_FACT_KINDS.has(item.kind)).map((item) => [item.runId, item]),
  );
}

function collectRoles(node: RunTreeNode, output: Map<RunId, string>): void {
  output.set(node.run.id, definitionLabel(String(node.run.definitionId)));
  for (const child of node.children) collectRoles(child, output);
}

function countNodes(node: RunTreeNode, predicate: (node: RunTreeNode) => boolean): number {
  return (
    (predicate(node) ? 1 : 0) +
    node.children.reduce((total, child) => total + countNodes(child, predicate), 0)
  );
}

function descendantCount(node: RunTreeNode): number {
  return node.children.reduce((total, child) => total + 1 + descendantCount(child), 0);
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

function thinking(
  theme: ObservabilityTheme | undefined,
  value: PiThinkingLevel,
  text: string,
): string {
  return color(theme, THINKING_TONES[value], text);
}

function formatDuration(start: string, end: string): string | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  const totalSeconds = Math.floor((endMs - startMs) / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
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
