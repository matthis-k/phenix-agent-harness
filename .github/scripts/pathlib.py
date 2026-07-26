from __future__ import annotations

import builtins
import os


def replace_once(text: str, old: str, new: str) -> str:
    if old not in text:
        raise AssertionError(f"missing refinement marker: {old[:80]!r}")
    return text.replace(old, new, 1)


def refine_ui(text: str) -> str:
    text = replace_once(
        text,
        'import { color, heading, type ObservabilityTheme, state, strong } from "./observability-theme.ts";\n',
        '''import {
  color,
  fact as factColor,
  heading,
  phase,
  reliability,
  type ObservabilityTheme,
  state,
  statusField as coloredStatusField,
  strong,
} from "./observability-theme.ts";
''',
    )
    text = replace_once(
        text,
        '''export type PhenixUiView = (typeof VIEW_ORDER)[number];
type UiPane = 0 | 1 | 2;
''',
        '''export type PhenixUiView = (typeof VIEW_ORDER)[number];
type UiPane = 0 | 1 | 2;

const PANE_LABELS: Readonly<Record<PhenixUiView, readonly string[]>> = {
  status: ["Overview"],
  runs: ["Run tree", "Sequence", "Inspector"],
  facts: ["Fact list", "Detail"],
  catalog: ["Definitions", "Preview"],
};
''',
    )
    text = replace_once(
        text,
        '''    this.layout = {
      width,
      height,
      bodyStart: 3,
      bodyHeight: Math.max(1, height - 3),
      sidebarWidth: Math.min(44, Math.max(26, Math.floor(width * 0.34))),
    };
    this.rowHits.clear();
    if (width < 42 || height < 8) return this.renderSmall(width, height);
    const header = this.renderHeader(width);
    const rule = this.fitLine(color(this.theme, "dim", "─".repeat(width)), width);
    const body = this.help ? this.renderHelp(width, this.layout.bodyHeight) : this.renderView();
    const footer = this.renderFooter(width);
    return [header, rule, ...fitHeight(body, this.layout.bodyHeight, width), footer];
''',
        '''    this.layout = {
      width,
      height,
      bodyStart: 4,
      bodyHeight: Math.max(1, height - 4),
      sidebarWidth: Math.min(44, Math.max(26, Math.floor(width * 0.34))),
    };
    this.rowHits.clear();
    if (width < 42 || height < 9) return this.renderSmall(width, height);
    const header = this.renderHeader(width);
    const rule = this.fitLine(color(this.theme, "dim", "─".repeat(width)), width);
    const focus = this.renderFocusBar(width);
    const body = this.help ? this.renderHelp(width, this.layout.bodyHeight) : this.renderView();
    const footer = this.renderFooter(width);
    return [header, rule, focus, ...fitHeight(body, this.layout.bodyHeight, width), footer];
''',
    )
    text = replace_once(
        text,
        '''    const tabs = VIEW_ORDER.map((view, index) => {
      const label = `[${index + 1} ${capitalize(view)}]`;
      const start = rawColumn;
      const end = start + visibleWidth(label) - 1;
      hits.push({ view, start, end });
      rawColumn = end + 2;
      return this.view === view ? heading(this.theme, label) : color(this.theme, "muted", label);
    }).join(" ");
''',
        '''    const tabs = VIEW_ORDER.map((view, index) => {
      const active = this.view === view;
      const label = `[${active ? "●" : " "} ${index + 1} ${capitalize(view)}]`;
      const start = rawColumn;
      const end = start + visibleWidth(label) - 1;
      hits.push({ view, start, end });
      rawColumn = end + 2;
      return active ? heading(this.theme, label) : color(this.theme, "dim", label);
    }).join(" ");
''',
    )
    text = replace_once(
        text,
        '''  private renderFooter(width: number): string {
''',
        '''  private renderFocusBar(width: number): string {
    const panes = PANE_LABELS[this.view];
    const labels = panes
      .map((label, index) =>
        index === this.pane
          ? heading(this.theme, `● ${label}`)
          : color(this.theme, "dim", `○ ${label}`),
      )
      .join(color(this.theme, "dim", "  │  "));
    return this.fitLine(` ${color(this.theme, "muted", `${capitalize(this.view)}:`)} ${labels}`, width);
  }

  private selectedRow(text: string, pane: UiPane): string {
    return this.pane === pane
      ? heading(this.theme, `▶ ${text}`)
      : color(this.theme, "text", `▷ ${text}`);
  }

  private renderFooter(width: number): string {
''',
    )
    text = replace_once(
        text,
        '    const pane = color(this.theme, "accent", `pane ${this.pane + 1}/${this.paneCount()}`);\n',
        '''    const paneLabel = PANE_LABELS[this.view][this.pane] ?? `pane ${this.pane + 1}`;
    const pane = heading(this.theme, `focus ${paneLabel}`);
''',
    )
    text = replace_once(
        text,
        '''      ` ${statusField("agent", this.snapshot.profile.agent)}  ${statusField("model", this.snapshot.profile.modelSet)}  ${statusField("difficulty", this.snapshot.profile.difficulty)}  ${statusField("integrations", this.snapshot.integrations)}`,
      ` ${statusField("sequence", String(this.snapshot.sequence))}  ${statusField("diagnostics", `${this.snapshot.diagnostics.counts.warning} warning / ${this.snapshot.diagnostics.counts.error} error`)}`,
''',
        '''      ` ${coloredStatusField(this.theme, "agent", this.snapshot.profile.agent, "text")}  ${coloredStatusField(this.theme, "model", this.snapshot.profile.modelSet, "accent")}  ${coloredStatusField(this.theme, "difficulty", this.snapshot.profile.difficulty, "warning")}  ${coloredStatusField(this.theme, "integrations", this.snapshot.integrations, "success")}`,
      ` ${coloredStatusField(this.theme, "sequence", String(this.snapshot.sequence), "accent")}  ${coloredStatusField(this.theme, "diagnostics", `${this.snapshot.diagnostics.counts.warning} warning / ${this.snapshot.diagnostics.counts.error} error`, this.snapshot.diagnostics.counts.error > 0 ? "error" : this.snapshot.diagnostics.counts.warning > 0 ? "warning" : "success")}`,
''',
    )
    text = replace_once(
        text,
        '''      const line = runSummary(run.node, run.depth);
      lines.push(selected ? heading(this.theme, `→ ${line}`) : `  ${line}`);
''',
        '''      const line = runSummary(this.theme, run.node, run.depth);
      lines.push(selected ? this.selectedRow(line, 0) : `  ${line}`);
''',
    )
    text = replace_once(
        text,
        '''      const line = formatFactLine(fact);
      lines.push(selected ? heading(this.theme, `→ ${line}`) : `  ${line}`);
''',
        '''      const line = formatFactLine(this.theme, fact);
      lines.push(selected ? this.selectedRow(line, 0) : `  ${line}`);
''',
    )
    text = replace_once(
        text,
        '''      const text = `${"  ".repeat(item.depth)}${disclosure} ${symbol} ${definitionLabel(String(run.definitionId))} ${color(this.theme, "dim", run.state)}${model}`;
      this.rowHits.set(this.layout.bodyStart + row, { view: "runs", index, pane: 0 });
      return this.fitLine(selected ? heading(this.theme, `→ ${text}`) : `  ${text}`, width);
''',
        '''      const text = `${"  ".repeat(item.depth)}${disclosure} ${symbol} ${strong(this.theme, definitionLabel(String(run.definitionId)))} ${state(this.theme, run.state, run.state)}${model}`;
      this.rowHits.set(this.layout.bodyStart + row, { view: "runs", index, pane: 0 });
      return this.fitLine(selected ? this.selectedRow(text, 0) : `  ${text}`, width);
''',
    )
    text = replace_once(
        text,
        '      ...facts.map((item) => formatFactLine(item)),\n',
        '      ...facts.map((item) => formatFactLine(this.theme, item)),\n',
    )
    text = replace_once(
        text,
        '''      const line = formatFactLine(item);
      return this.fitLine(selected ? heading(this.theme, `→ ${line}`) : `  ${line}`, width);
''',
        '''      const line = formatFactLine(this.theme, item);
      return this.fitLine(selected ? this.selectedRow(line, 0) : `  ${line}`, width);
''',
    )
    text = replace_once(
        text,
        '''      const kind = item.kind === "workflow" ? "W" : "A";
      const text = `${kind} ${definitionLabel(String(item.id))}`;
      this.rowHits.set(this.layout.bodyStart + row, { view: "catalog", index, pane: 0 });
      return this.fitLine(selected ? heading(this.theme, `→ ${text}`) : `  ${text}`, width);
''',
        '''      const kind =
        item.kind === "workflow"
          ? color(this.theme, "accent", "W")
          : color(this.theme, "success", "A");
      const text = `${kind} ${strong(this.theme, definitionLabel(String(item.id)))}`;
      this.rowHits.set(this.layout.bodyStart + row, { view: "catalog", index, pane: 0 });
      return this.fitLine(selected ? this.selectedRow(text, 0) : `  ${text}`, width);
''',
    )
    text = replace_once(
        text,
        '''      const firstRule = color(this.theme, this.pane === 0 ? "accent" : "dim", "│");
      if (inspectorWidth === 0) return `${left}${firstRule}${middle}`;
      const secondRule = color(this.theme, this.pane === 2 ? "accent" : "dim", "│");
''',
        '''      const firstRule = color(
        this.theme,
        this.pane === 0 || this.pane === 1 ? "accent" : "dim",
        this.pane === 0 || this.pane === 1 ? "┃" : "│",
      );
      if (inspectorWidth === 0) return `${left}${firstRule}${middle}`;
      const secondRule = color(
        this.theme,
        this.pane === 1 || this.pane === 2 ? "accent" : "dim",
        this.pane === 1 || this.pane === 2 ? "┃" : "│",
      );
''',
    )
    text = replace_once(
        text,
        '''function runSummary(node: RunTreeNode, depth: number): string {
  const run = node.run;
  const model = run.resolvedModel
    ? ` · ${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`
    : "";
  const activity = node.activity ? ` · ${node.activity.phase} ${truncate(node.activity.summary, 48)}` : "";
  return `${"  ".repeat(depth)}${runStateSymbol(run.state)} ${definitionLabel(String(run.definitionId))} [${run.state}]${model}${activity}`;
}

function formatFactLine(item: RunFact): string {
  return `${compactTimestamp(item.timestamp)} ${shortRunId(String(item.runId))} · ${item.kind} · ${truncate(item.summary, 96)}`;
}
''',
        '''function runSummary(theme: ObservabilityTheme, node: RunTreeNode, depth: number): string {
  const run = node.run;
  const model = run.resolvedModel
    ? ` ${color(theme, "dim", "·")} ${color(theme, "muted", `${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`)}`
    : "";
  const activity = node.activity
    ? ` ${color(theme, "dim", "·")} ${phase(theme, node.activity.phase, node.activity.phase)} ${color(theme, "text", truncate(node.activity.summary, 48))}`
    : "";
  return `${"  ".repeat(depth)}${state(theme, run.state, runStateSymbol(run.state))} ${strong(theme, definitionLabel(String(run.definitionId)))} ${state(theme, run.state, `[${run.state}]`)}${model}${activity}`;
}

function formatFactLine(theme: ObservabilityTheme, item: RunFact): string {
  return `${color(theme, "dim", compactTimestamp(item.timestamp))} ${color(theme, "muted", shortRunId(String(item.runId)))} ${color(theme, "dim", "·")} ${factColor(theme, item.kind, item.summary, item.kind)} ${color(theme, "dim", "·")} ${factColor(theme, item.kind, item.summary, truncate(item.summary, 84))} ${reliability(theme, item.reliability, `[${item.reliability}]`)}`;
}
''',
    )
    return text


def refine_tests() -> None:
    target = "modules/phenix-pi/tests/phenix-ui.test.ts"
    with builtins.open(target, encoding="utf-8") as handle:
        text = handle.read()
    text = replace_once(
        text,
        '''const theme = {
  fg: (_tone: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ObservabilityTheme;
''',
        '''const theme = {
  fg: (_tone: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ObservabilityTheme;

const ANSI_TONES: Readonly<Record<string, string>> = {
  accent: "35",
  success: "32",
  error: "31",
  warning: "33",
  muted: "90",
  dim: "2",
  text: "37",
};
const ansiTheme = {
  fg: (tone: string, text: string) => `\\x1b[${ANSI_TONES[tone] ?? "37"}m${text}\\x1b[0m`,
  bold: (text: string) => `\\x1b[1m${text}\\x1b[22m`,
} as unknown as ObservabilityTheme;
''',
    )
    text = replace_once(text, '  assert.match(ui.render(100)[0] ?? "", /\\[4 Catalog\\]/);\n', '  assert.match(ui.render(100)[0] ?? "", /4 Catalog/);\n')
    text = replace_once(text, '  assert.match(ui.render(100)[0] ?? "", /\\[2 Runs\\]/);\n', '  assert.match(ui.render(100)[0] ?? "", /2 Runs/);\n')
    marker = '''test("keyboard and mouse switch unified UI views", () => {
  const tui = fakeTui(16);
  const ui = createUi(tui, { view: "status" });

  ui.handleInput("4");
  assert.match(ui.render(100)[0] ?? "", /4 Catalog/);
  assert.match(ui.render(100).join("\\n"), /workflow/);

  ui.handleInput("\\x1b[<0;20;1M");
  assert.match(ui.render(100)[0] ?? "", /2 Runs/);
  assert.ok(tui.renderRequests > 0);
});
'''
    text = replace_once(
        text,
        marker,
        marker
        + '''
test("colors the active tab, focused pane, and semantic catalog and fact state", () => {
  const tui = fakeTui(18);
  const ui = createUi(tui, { view: "catalog", selector: "qa" }, ansiTheme);

  let lines = ui.render(100);
  assert.ok(lines[0]?.includes("\\x1b[35m\\x1b[1m[● 4 Catalog]"));
  assert.ok(lines[2]?.includes("\\x1b[35m\\x1b[1m● Definitions"));
  assert.ok(lines.join("\\n").includes("\\x1b[35mW\\x1b[0m"));

  ui.handleInput("\\t");
  lines = ui.render(100);
  assert.ok(lines[2]?.includes("\\x1b[35m\\x1b[1m● Preview"));
  assert.ok(lines.join("\\n").includes("\\x1b[37m▷ "));

  const facts = createUi(fakeTui(18), { view: "facts" }, ansiTheme).render(100).join("\\n");
  assert.ok(facts.includes("\\x1b[35mrun-started\\x1b[0m"));
  assert.ok(facts.includes("\\x1b[32m[observed]\\x1b[0m"));
});
''',
    )
    text = replace_once(
        text,
        '''function createUi(tui: FakeTui, initial: { readonly view: "status" | "runs" | "facts" | "catalog"; readonly selector?: string }): PhenixUi {
  const snapshot = fixtureSnapshot();
  return new PhenixUi({
    tui,
    theme,
''',
        '''function createUi(
  tui: FakeTui,
  initial: {
    readonly view: "status" | "runs" | "facts" | "catalog";
    readonly selector?: string;
  },
  uiTheme: ObservabilityTheme = theme,
): PhenixUi {
  const snapshot = fixtureSnapshot();
  return new PhenixUi({
    tui,
    theme: uiTheme,
''',
    )
    with builtins.open(target, "w", encoding="utf-8") as handle:
        handle.write(text)


class Path:
    def __init__(self, *parts: str) -> None:
        self.path = os.path.join(*(os.fspath(part) for part in parts))

    def read_text(self, encoding: str = "utf-8") -> str:
        with builtins.open(self.path, encoding=encoding) as handle:
            return handle.read()

    def write_text(self, data: str, encoding: str = "utf-8") -> int:
        if self.path.endswith("modules/phenix-pi/extension/phenix-ui.ts"):
            data = refine_ui(data)
            refine_tests()
        with builtins.open(self.path, "w", encoding=encoding) as handle:
            written = handle.write(data)
        try:
            os.unlink(__file__)
        except FileNotFoundError:
            pass
        return written
