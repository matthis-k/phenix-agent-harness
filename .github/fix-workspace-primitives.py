from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

layout_path = ROOT / "modules/phenix-pi/domain/workspace/layout.ts"
layout = layout_path.read_text()
layout = layout.replace('readonly then: LayoutNode;', 'readonly whenTrue: LayoutNode;')
layout = layout.replace('readonly otherwise?: LayoutNode;', 'readonly whenFalse?: LayoutNode;')
layout = layout.replace('node.then', 'node.whenTrue')
layout = layout.replace('node.otherwise', 'node.whenFalse')
layout_path.write_text(layout)

render_path = ROOT / "modules/phenix-pi/domain/workspace/render.ts"
render = render_path.read_text()
render = render.replace(', localRect, point, rect,', ', localRect, rect,')
render = render.replace(
    '''    for (const [index, value] of cells.entries()) {
      const target = column + index;
      if (target < 0 || target >= this.width) continue;
      this.rows[row]![target] = value;
    }''',
    '''    const targetRow = this.rows[row];
    if (!targetRow) return;
    for (const [index, value] of cells.entries()) {
      const target = column + index;
      if (target < 0 || target >= this.width) continue;
      targetRow[target] = value;
    }''',
)
render = render.replace(
    '''    for (let row = clipped.y; row < clipped.y + clipped.height; row += 1) {
      for (let column = clipped.x; column < clipped.x + clipped.width; column += 1) {
        this.rows[row]![column] = value;
      }
    }''',
    '''    for (let row = clipped.y; row < clipped.y + clipped.height; row += 1) {
      const targetRow = this.rows[row];
      if (!targetRow) continue;
      for (let column = clipped.x; column < clipped.x + clipped.width; column += 1) {
        targetRow[column] = value;
      }
    }''',
)
render_path.write_text(render)

test_path = ROOT / "modules/phenix-pi/tests/workspace-primitives.test.ts"
test = test_path.read_text()
test = test.replace('then: pane("runs", 32, 1, 100),', 'whenTrue: pane("runs", 32, 1, 100),')
test = test.replace(
    '          assert.equal(intersects(panes[left]!, panes[right]!), false);',
    '''          const leftPane = panes[left];
          const rightPane = panes[right];
          assert.ok(leftPane);
          assert.ok(rightPane);
          assert.equal(intersects(leftPane, rightPane), false);''',
)
test_path.write_text(test)
