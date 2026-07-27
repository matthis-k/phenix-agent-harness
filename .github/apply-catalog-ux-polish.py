from pathlib import Path

ui_path = Path("modules/phenix-pi/extension/phenix-ui.ts")
ui = ui_path.read_text()

old_footer = '''  private renderFooter(width: number): string {
    const filter = this.filtering
      ? color(this.theme, "accent", ` filter: ${this.filter}▌`)
      : this.filter
        ? color(this.theme, "muted", ` filter:${this.filter}`)
        : "";
    const paneLabel = PANE_LABELS[this.view][this.pane] ?? `pane ${this.pane + 1}`;
    const pane = heading(this.theme, `focus ${paneLabel}`);
    const hints = this.footerHints();
    return surface(
      this.theme,
      "customMessageBg",
      this.fitLine(`${color(this.theme, "muted", ` ${hints}`)}${filter}  ${pane}`, width),
    );
  }

  private footerHints(): string {
    if (this.goPrefix) return "g…  s status · r runs · f facts · c catalog";
    return "1-4 views · Tab pane · / filter · arrows/hjkl navigate · ? help · r refresh · Esc close";
  }
'''
new_footer = '''  private renderFooter(width: number): string {
    const filter = this.filtering
      ? color(this.theme, "accent", ` filter: ${this.filter}▌`)
      : this.filter
        ? color(this.theme, "muted", ` filter:${this.filter}`)
        : "";
    const pane =
      this.paneCount() > 1
        ? `  ${heading(
            this.theme,
            `focus ${PANE_LABELS[this.view][this.pane] ?? `pane ${this.pane + 1}`}`,
          )}`
        : "";
    const hints = this.footerHints();
    return surface(
      this.theme,
      "customMessageBg",
      this.fitLine(`${color(this.theme, "muted", ` ${hints}`)}${filter}${pane}`, width),
    );
  }

  private footerHints(): string {
    if (this.goPrefix) return "g…  s status · r runs · f facts · c catalog";
    const paneHint = this.paneCount() > 1 ? " · Tab pane" : "";
    return `1-4 views${paneHint} · / filter · arrows/hjkl navigate · ? help · r refresh · Esc close`;
  }
'''
if ui.count(old_footer) != 1:
    raise SystemExit("footer block was not found exactly once")
ui = ui.replace(old_footer, new_footer)

old_workflow = '''    if (definition.kind === "workflow") {
      const nodes = definition.graph.nodes.length;
      const edges = definition.graph.edges.length;
      return [
        heading(this.theme, " Selected definition"),
        strong(this.theme, ` ${definition.title}`),
        identity,
        description,
        color(
          this.theme,
          "muted",
          ` ${nodes} nodes · ${edges} transitions · entry ${definition.graph.entry}`,
        ),
'''
new_workflow = '''    if (definition.kind === "workflow") {
      const nodes = definition.graph.nodes.length;
      const edges = definition.graph.edges.length;
      const nodeCount = `${nodes} ${nodes === 1 ? "node" : "nodes"}`;
      const transitionCount = `${edges} ${edges === 1 ? "transition" : "transitions"}`;
      return [
        heading(this.theme, " Selected definition"),
        strong(this.theme, ` ${definition.title}`),
        identity,
        description,
        color(
          this.theme,
          "muted",
          ` ${nodeCount} · ${transitionCount} · entry ${definition.graph.entry}`,
        ),
'''
if ui.count(old_workflow) != 1:
    raise SystemExit("workflow inspector block was not found exactly once")
ui = ui.replace(old_workflow, new_workflow)

ui = ui.replace(
    '      coloredStatusField(this.theme, "model", model, "accent"),\n      coloredStatusField(this.theme, "thinking", definition.thinking, "warning"),\n      coloredStatusField(this.theme, "tools", tools, "text"),',
    '      ` ${coloredStatusField(this.theme, "model", model, "accent")}`,\n      ` ${coloredStatusField(this.theme, "thinking", definition.thinking, "warning")}`,\n      ` ${coloredStatusField(this.theme, "tools", tools, "text")}`,',
)
ui_path.write_text(ui)

test_path = Path("modules/phenix-pi/tests/phenix-ui.test.ts")
tests = test_path.read_text()
tests = tests.replace(
    '  assert.doesNotMatch(lines.join("\\n"), /Overview/);',
    '  assert.doesNotMatch(lines.join("\\n"), /Overview|Tab pane|focus Overview/);',
)
tests = tests.replace(
    '/2 nodes · 1 transitions · entry start/',
    '/2 nodes · 1 transition · entry start/',
)
test_path.write_text(tests)
