import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { RunTree, RunTreeNode } from "../application/interfaces.ts";
import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
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

export type RunMonitorMode = "hidden" | "runs" | "facts";

export interface FactHistoryExport {
  readonly text: string;
  readonly count: number;
}

export class RunMonitor {
  private readonly ctx: ExtensionContext;
  private readonly runtime: PhenixRuntime;
  private readonly rootRunId: RunId;
  private mode: RunMonitorMode = "hidden";
  private refreshing = false;
  private pending = false;
  private disposed = false;

  constructor(ctx: ExtensionContext, runtime: PhenixRuntime, rootRunId: RunId) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.rootRunId = rootRunId;
  }

  get currentMode(): RunMonitorMode {
    return this.mode;
  }

  async show(mode: Exclude<RunMonitorMode, "hidden">): Promise<void> {
    if (this.disposed) return;
    this.mode = mode;
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

  async once(mode: Exclude<RunMonitorMode, "hidden">): Promise<string> {
    return (await this.render(mode, this.ctx.ui.theme)).join("\n");
  }

  async json(mode: Exclude<RunMonitorMode, "hidden">): Promise<string> {
    if (mode === "facts") {
      return JSON.stringify(await this.runtime.queries.facts(this.rootRunId), null, 2);
    }
    const [tree, facts] = await Promise.all([
      this.runtime.queries.runTree(this.rootRunId),
      this.runtime.queries.facts(this.rootRunId, 100),
    ]);
    return JSON.stringify(
      { sequence: this.runtime.sequence(this.rootRunId), tree, facts },
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
    const [tree, facts] = await Promise.all([
      this.runtime.queries.runTree(this.rootRunId),
      this.runtime.queries.facts(this.rootRunId, 8),
    ]);
    return renderRuns(tree, facts, this.runtime.sequence(this.rootRunId), theme);
  }
}

export function createUnboundedWidget(lines: readonly string[]): () => Text {
  const content = lines.join("\n");
  return () => new Text(content, 1, 0);
}

export function renderRuns(
  tree: RunTree,
  facts: readonly RunFact[],
  sequence: number,
  theme?: ObservabilityTheme,
): string[] {
  const lines = [heading(theme, `Phenix live runs · seq ${sequence}`)];
  appendNode(lines, tree.root, "", true, theme, true);
  if (facts.length > 0) {
    lines.push("", heading(theme, "Recent facts"));
    for (const factItem of facts.slice(-8)) lines.push(formatFact(factItem, true, theme));
  }
  lines.push("", color(theme, "dim", "/phenix runs off · /phenix facts"));
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
  lines.push("", color(theme, "dim", "/phenix facts off · /phenix runs"));
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
  root = false,
): void {
  const branch = root ? "" : last ? "└─ " : "├─ ";
  const symbol = state(theme, node.run.state, stateSymbol(node.run.state));
  const label = strong(theme, definitionLabel(String(node.run.definitionId)));
  const stateLabel = state(theme, node.run.state, `[${node.run.state}]`);
  lines.push(`${color(theme, "dim", `${prefix}${branch}`)}${symbol} ${label} ${stateLabel}`);
  const contentPrefix = root ? "   " : `${prefix}${last ? "   " : "│  "}`;
  if (node.activity) {
    const target = node.activity.target
      ? `${color(theme, "dim", " · ")}${color(theme, "muted", truncate(node.activity.target, 72))}`
      : "";
    const reported =
      node.activity.source === "reported" ? color(theme, "warning", "! ") : "";
    lines.push(
      `${color(theme, "dim", contentPrefix)}${reported}${phase(
        theme,
        node.activity.phase,
        node.activity.phase,
      )}${color(theme, "dim", " · ")}${color(
        theme,
        "text",
        truncate(node.activity.summary, 72),
      )}${target}`,
    );
  }
  const childPrefix = root ? "" : contentPrefix;
  node.children.forEach((child, index) => {
    appendNode(lines, child, childPrefix, index === node.children.length - 1, theme);
  });
}

function formatFact(
  factItem: RunFact,
  compact = true,
  theme?: ObservabilityTheme,
): string {
  const reliabilitySymbol =
    factItem.reliability === "observed" ? "✓" : factItem.reliability === "derived" ? "≈" : "!";
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
    reliabilitySymbol,
  )} ${color(theme, "muted", run)}${color(theme, "dim", " · ")}${fact(
    theme,
    factItem.kind,
    summary,
    summary,
  )}${subject}`;
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
  return value === "completed"
    ? "✓"
    : value === "failed" || value === "orphaned"
      ? "✗"
      : value === "cancelled"
        ? "−"
        : value === "waiting"
          ? "○"
          : "●";
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
