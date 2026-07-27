from pathlib import Path

ui_path = Path("modules/phenix-pi/extension/phenix-ui.ts")
ui = ui_path.read_text()
old = '''        color(
          this.theme,
          "muted",
          ` ${nodeCount} · ${transitionCount} · entry ${definition.graph.entry}`,
        ),
        color(
          this.theme,
          "muted",
          ` ${definition.limits.timeoutMs} ms timeout · ${definition.limits.maxParallelism} parallel`,
        ),'''
new = '''        color(this.theme, "muted", ` ${nodeCount} · ${transitionCount}`),
        color(
          this.theme,
          "muted",
          ` entry ${definition.graph.entry} · ${definition.limits.timeoutMs}ms · parallel ${definition.limits.maxParallelism}`,
        ),'''
if ui.count(old) != 1:
    raise SystemExit("workflow metadata block was not found exactly once")
ui_path.write_text(ui.replace(old, new))

test_path = Path("modules/phenix-pi/tests/phenix-ui.test.ts")
tests = test_path.read_text()
old_assertion = '  assert.match(lines.join("\\n"), /2 nodes · 1 transition · entry start/);'
new_assertions = '''  assert.match(lines.join("\\n"), /2 nodes · 1 transition/);
  assert.match(lines.join("\\n"), /entry start · 1000ms · parallel 1/);'''
if tests.count(old_assertion) != 1:
    raise SystemExit("Catalog metadata assertion was not found exactly once")
test_path.write_text(tests.replace(old_assertion, new_assertions))
