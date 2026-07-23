import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RunTree, RunTreeNode } from "../application/interfaces.ts";
import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import type { RunFact } from "../domain/run/observability.ts";
import type { RunId } from "../domain/shared.ts";

const WIDGET_KEY = "phenix-live-runs";
const MAX_TREE_LINES = 36;
const MAX_FACT_LINES = 24;

export type RunMonitorMode = "hidden" | "runs" | "facts";

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
        const requestedMode: RunMonitorMode = this.mode;
        if (requestedMode === "hidden") return;
        const lines = await this.render(requestedMode);
        if (!this.disposed && this.mode === requestedMode) {
          this.ctx.ui.setWidget?.(WIDGET_KEY, lines, { placement: "aboveEditor" });
        }
      } while (this.pending && !this.disposed);
    } finally {
      this.refreshing = false;
    }
  }

  async once(mode: Exclude<RunMonitorMode, "hidden">): Promise<string> {
    return (await this.render(mode)).join("\n");
  }

  async json(mode: Exclude<RunMonitorMode, "hidden">): Promise<string> {
    if (mode === "facts") {
      return JSON.stringify(await this.runtime.queries.facts(this.rootRunId, 1_000), null, 2);
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

  dispose(): void {
    this.disposed = true;
    this.hide();
  }

  private async render(mode: Exclude<RunMonitorMode, "hidden">): Promise<string[]> {
    if (mode === "facts") {
      const facts = await this.runtime.queries.facts(this.rootRunId, MAX_FACT_LINES);
      return renderFacts(facts, this.runtime.sequence(this.rootRunId));
    }
    const [tree, facts] = await Promise.all([
      this.runtime.queries.runTree(this.rootRunId),
      this.runtime.queries.facts(this.rootRunId, 8),
    ]);
    return renderRuns(tree, facts, this.runtime.sequence(this.rootRunId));
  }
}

export function renderRuns(tree: RunTree, facts: readonly RunFact[], sequence: number): string[] {
  const lines = [`Phenix live runs · seq ${sequence}`];
  appendNode(lines, tree.root, "", true, true);
  if (lines.length > MAX_TREE_LINES) {
    lines.splice(MAX_TREE_LINES, lines.length - MAX_TREE_LINES, "… run tree truncated");
  }
  if (facts.length > 0) {
    lines.push("", "Recent facts");
    for (const fact of facts.slice(-8)) lines.push(formatFact(fact));
  }
  lines.push("", "/phenix runs off · /phenix facts");
  return lines;
}

export function renderFacts(facts: readonly RunFact[], sequence: number): string[] {
  const lines = [`Phenix fact history · seq ${sequence}`];
  if (facts.length === 0) lines.push("No facts recorded yet.");
  for (const fact of facts.slice(-MAX_FACT_LINES)) lines.push(formatFact(fact));
  lines.push("", "/phenix facts off · /phenix runs");
  return lines;
}

function appendNode(
  lines: string[],
  node: RunTreeNode,
  prefix: string,
  last: boolean,
  root = false,
): void {
  if (lines.length >= MAX_TREE_LINES) return;
  const branch = root ? "" : last ? "└─ " : "├─ ";
  const symbol = stateSymbol(node.run.state);
  const label = definitionLabel(String(node.run.definitionId));
  lines.push(`${prefix}${branch}${symbol} ${label} [${node.run.state}]`);
  const contentPrefix = root ? "   " : `${prefix}${last ? "   " : "│  "}`;
  if (node.activity && lines.length < MAX_TREE_LINES) {
    const target = node.activity.target ? ` · ${truncate(node.activity.target, 72)}` : "";
    const reliability = node.activity.source === "reported" ? "!" : "";
    lines.push(
      `${contentPrefix}${reliability}${node.activity.phase} · ${truncate(node.activity.summary, 72)}${target}`,
    );
  }
  const childPrefix = root ? "" : contentPrefix;
  node.children.forEach((child, index) =>
    appendNode(lines, child, childPrefix, index === node.children.length - 1),
  );
}

function formatFact(fact: RunFact): string {
  const reliability =
    fact.reliability === "observed" ? "✓" : fact.reliability === "derived" ? "≈" : "!";
  const time = fact.timestamp.length >= 19 ? fact.timestamp.slice(11, 19) : fact.timestamp;
  const run = shortRunId(fact.runId);
  const subject = fact.subject ? ` · ${truncate(fact.subject, 64)}` : "";
  return `${time} ${reliability} ${run} · ${truncate(fact.summary, 100)}${subject}`;
}

function definitionLabel(value: string): string {
  return value.replace(/^(?:agent|workflow)\./, "");
}

function shortRunId(value: RunId): string {
  const text = String(value);
  const parts = text.split("-");
  return truncate(parts.length > 2 ? parts.slice(0, 2).join("-") : text, 24);
}

function stateSymbol(state: string): string {
  return state === "completed"
    ? "✓"
    : state === "failed" || state === "orphaned"
      ? "✗"
      : state === "cancelled"
        ? "−"
        : state === "waiting"
          ? "○"
          : "●";
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
