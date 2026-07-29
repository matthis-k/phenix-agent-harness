import assert from "node:assert/strict";
import test from "node:test";

import {
  DocumentView,
  ListView,
  listBlock,
  spacerBlock,
  TerminalView,
  terminalBlock,
  textBlock,
  TreeView,
  treeBlock,
} from "../extension/components/index.ts";
import { documentComponent } from "../extension/presentation-component.ts";

test("document view composes generic blocks without domain knowledge", () => {
  const list = new ListView<string>(
    { id: (item) => item, render: (item) => `list:${item}` },
    { selectFirstItem: false },
  );
  list.setItems(["a", "b"]);

  const tree = new TreeView<{ readonly id: string; readonly children: readonly any[] }>(
    {
      id: (node) => node.id,
      children: (node) => node.children,
      render: (node) => `tree:${node.id}`,
    },
    { selectFirstItem: false },
  );
  tree.setRoots([{ id: "root", children: [{ id: "child", children: [] }] }]);
  tree.setExpanded(["root"]);

  const terminal = new TerminalView();
  terminal.setLines(["terminal:one", "terminal:two"]);

  const document = new DocumentView([
    textBlock(["header"]),
    spacerBlock(),
    listBlock(list),
    treeBlock(tree),
    terminalBlock(terminal),
  ]);
  const frame = document.render(30, { trimEnd: true });

  assert.deepEqual(frame.lines, [
    "header",
    "",
    "list:a",
    "list:b",
    "▾ tree:root",
    "    tree:child",
    "terminal:one",
    "terminal:two",
  ]);
});

test("document component is a thin Pi adapter over a headless document", () => {
  const component = documentComponent(["alpha", "beta"], { paddingX: 1 });
  const lines = component.render(8);

  assert.equal(lines.length, 2);
  assert.equal(lines[0], " alpha  ");
  assert.equal(lines[1], " beta   ");
});

test("tree view exposes its visible row count for document composition", () => {
  const tree = new TreeView<{ readonly id: string; readonly children: readonly any[] }>(
    {
      id: (node) => node.id,
      children: (node) => node.children,
      render: (node) => node.id,
    },
    { selectFirstItem: false },
  );
  tree.setRoots([{ id: "root", children: [{ id: "child", children: [] }] }]);
  assert.equal(tree.itemCount, 1);
  tree.setExpanded(["root"]);
  assert.equal(tree.itemCount, 2);
});
