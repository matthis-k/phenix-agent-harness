import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { RunTree, RunTreeNode } from "../application/interfaces.ts";
import type { DiagnosticSummary } from "../domain/diagnostics.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import {
  color,
  heading,
  type ObservabilityTheme,
  state,
  strong,
  surface,
} from "./observability-theme.ts";

const MAX_TREE_LINES = 10;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);

export interface PhenixSidebarData {
  readonly tree: RunTree;
  readonly sequence: number;
  readonly profile: SessionProfile;
  readonly diagnostics: DiagnosticSummary;
}

export function shouldShowPhenixSidebar(
  data: PhenixSidebarData,
  phenixModelSelected: boolean,
): boolean {
  return (
    phenixModelSelected ||
    data.profile.agent !== "base" ||
    data.tree.root.children.length > 0
  );
}

export function createPhenixSidebarWidget(
  data: PhenixSidebarData,
): (_tui: TUI, theme: ObservabilityTheme) => Component {
  return (_tui, theme) => new PhenixSidebarWidget(data, theme);
}

export function renderPhenixSidebar(
  data: PhenixSidebarData,
  theme?: ObservabilityTheme,
): readonly string[] {
  const active = countNodes(
    data.tree.root,
    (node) => node.run.id !== data.tree.root.run.id && !TERMINAL_STATES.has(node.run.state),
  );
  const health =
    data.diagnostics.counts.error > 0
      ? color(theme, "error", `${data.diagnostics.counts.error} errors`)
      : data.diagnostics.counts.warning > 0
        ? color(theme, "warning", `${data.diagnostics.counts.warning} warnings`)
        : color(theme, "success", "healthy");
  const lines: string[] = [
    heading(theme, " Phenix"),
    ` ${strong(theme, data.profile.agent)}  ${color(theme, "accent", data.profile.modelSet)}  ${color(theme, "warning", data.profile.difficulty)}`,
    ` ${color(theme, active > 0 ? "warning" : "success", active > 0 ? `${active} active` : "idle")}  ${health}  ${color(theme, "muted", `seq ${data.sequence}`)}`,
    "",
  ];
  if (data.tree.root.children.length === 0) {
    lines.push(color(theme, "muted", " No workflow runs yet."));
    return lines;
  }
  lines.push(heading(theme, " Run tree"));
  appendChildren(lines, data.tree.root, 0, theme);
  if (lines.length > MAX_TREE_LINES + 5) {
    lines.length = MAX_TREE_LINES + 5;
    lines.push(color(theme, "dim", " … more in /phenix"));
  }
  return lines;
}

class PhenixSidebarWidget implements Component {
  constructor(
    private readonly data: PhenixSidebarData,
    private readonly theme: ObservabilityTheme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderPhenixSidebar(this.data, this.theme).map((line) =>
      surface(this.theme, "customMessageBg", fitLine(line, width)),
    );
  }
}

function appendChildren(
  lines: string[],
  node: RunTreeNode,
  depth: number,
  theme: ObservabilityTheme | undefined,
): void {
  for (const child of node.children) {
    if (lines.length >= MAX_TREE_LINES + 5) return;
    const run = child.run;
    const indent = " ".repeat(1 + depth * 2);
    const symbol = state(theme, run.state, stateSymbol(run.state));
    const label = strong(theme, definitionLabel(String(run.definitionId)));
    lines.push(`${indent}${symbol} ${label} ${state(theme, run.state, run.state)}`);
    if (run.state === "running" && child.activity && lines.length < MAX_TREE_LINES + 5) {
      lines.push(
        `${indent}  ${color(theme, "muted", truncate(child.activity.summary, 30))}`,
      );
    }
    const collapseCompleted = run.state === "completed" && child.children.length > 0;
    if (collapseCompleted) {
      const failed = countNodes(
        child,
        (current) => current !== child && (current.run.state === "failed" || current.run.state === "orphaned"),
      );
      lines.push(
        `${indent}  ${color(theme, failed > 0 ? "error" : "success", `${child.children.length} child${child.children.length === 1 ? "" : "ren"}${failed > 0 ? ` · ${failed} failed` : ""}`)}`,
      );
    } else {
      appendChildren(lines, child, depth + 1, theme);
    }
  }
}

function fitLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function countNodes(node: RunTreeNode, predicate: (node: RunTreeNode) => boolean): number {
  return (
    (predicate(node) ? 1 : 0) +
    node.children.reduce((total, child) => total + countNodes(child, predicate), 0)
  );
}

function definitionLabel(value: string): string {
  return value.replace(/^(?:agent|workflow)\./, "");
}

function stateSymbol(value: string): string {
  if (value === "completed") return "✓";
  if (value === "failed" || value === "orphaned") return "✗";
  if (value === "cancelled") return "−";
  if (value === "waiting") return "○";
  return "●";
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}
