from pathlib import Path


renderer_path = Path("modules/phenix-pi/extension/mermaid-rendering.ts")
renderer = renderer_path.read_text()
old_collapsed = '''      if (collapsed) {
        lines.push(
          `  Note over ${caller}: ${escapeSequenceText(
            `workflow ${label}<br/>${descendantCount(node)} descendants`,
          )}`,
        );
        return;
      }
'''
new_collapsed = '''      if (collapsed) {
        lines.push(
          `  ${caller}->>${caller}: ${escapeSequenceText(
            `workflow ${label} · ${descendantCount(node)} descendants`,
          )}`,
        );
        return;
      }
'''
if old_collapsed not in renderer:
    raise SystemExit("collapsed workflow sequence block not found")
renderer_path.write_text(renderer.replace(old_collapsed, new_collapsed, 1))

monitor_path = Path("modules/phenix-pi/extension/run-monitor.ts")
monitor = monitor_path.read_text()
old_render = '''      lines.push(...renderRunTreeSequence(data.tree, { expanded: data.expanded }).split("\\n"));
'''
new_render = '''      lines.push(
        ...renderRunTreeSequence(data.tree, { expanded: data.expanded })
          .split("\\n")
          .map((line) => colorSequenceLine(line, theme)),
      );
'''
if old_render not in monitor:
    raise SystemExit("sequence dashboard render call not found")
monitor = monitor.replace(old_render, new_render, 1)
marker = '''export function renderFacts(
'''
helper = '''function colorSequenceLine(
  line: string,
  theme: ObservabilityTheme | undefined,
): string {
  let rendered = line;
  for (const value of [
    "completed",
    "failed",
    "orphaned",
    "waiting",
    "cancelled",
    "running",
  ]) {
    rendered = rendered.replaceAll(value, state(theme, value, value));
  }
  return rendered;
}

'''
if "function colorSequenceLine(" not in monitor:
    if marker not in monitor:
        raise SystemExit("renderFacts insertion marker not found")
    monitor = monitor.replace(marker, helper + marker, 1)
monitor_path.write_text(monitor)

observability_path = Path("modules/phenix-pi/tests/observability-theme.test.ts")
observability = observability_path.read_text()
old_assertions = '''  assert.match(output, /<success>✓<\\/success>.*<success>\\[completed\\]<\\/success>/);
  assert.match(output, /<error>✗<\\/error>.*<error>\\[failed\\]<\\/error>/);
  assert.match(output, /<warning>○<\\/warning>.*<warning>\\[waiting\\]<\\/warning>/);
  assert.match(output, /<muted>−<\\/muted>.*<muted>\\[cancelled\\]<\\/muted>/);
  assert.match(output, /<muted>opencode-go\\/model-a · low<\\/muted>/);
'''
new_assertions = '''  assert.match(output, /<accent><bold>Execution sequence<\\/bold><\\/accent>/);
  assert.match(output, /<success>completed<\\/success>/);
  assert.match(output, /<error>failed<\\/error>/);
  assert.match(output, /<warning>waiting<\\/warning>/);
  assert.match(output, /<muted>cancelled<\\/muted>/);
  assert.match(output, /opencode-go\\/model-a · low/);
'''
if old_assertions not in observability:
    raise SystemExit("old observability sequence assertions not found")
observability_path.write_text(observability.replace(old_assertions, new_assertions, 1))
