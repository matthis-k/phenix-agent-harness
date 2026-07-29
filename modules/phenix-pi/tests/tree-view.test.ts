import assert from "node:assert/strict";
import test from "node:test";

import { TreeView } from "../extension/components/tree-view.ts";

interface Node {
  readonly id: string;
  readonly label: string;
  readonly children?: readonly Node[];
}

function createTree(): TreeView<Node> {
  return new TreeView<Node>({
    id: (node) => node.id,
    children: (node) => node.children ?? [],
    render: (node, context) => `${node.label}:${context.depth}`,
  });
}

const ROOT: Node = {
  id: "root",
  label: "Root",
  children: [
    {
      id: "child",
      label: "Child",
      children: [{ id: "grandchild", label: "Grandchild" }],
    },
    { id: "sibling", label: "Sibling" },
  ],
};

test("flattens only expanded branches and preserves selection", () => {
  const view = createTree();
  view.setRoots([ROOT]);
  assert.deepEqual(view.render(30, 5).visibleNodeIds, ["root"]);

  assert.deepEqual(view.dispatch({ kind: "toggle" }, 5), {
    kind: "expansion",
    id: "root",
    node: ROOT,
    expanded: true,
  });
  assert.deepEqual(view.render(30, 5).visibleNodeIds, ["root", "child", "sibling"]);

  view.dispatch({ kind: "move", direction: 1 }, 5);
  assert.equal(view.selectedId, "child");
  view.dispatch({ kind: "expand" }, 5);
  assert.deepEqual(view.render(30, 5).visibleNodeIds, [
    "root",
    "child",
    "grandchild",
    "sibling",
  ]);
  assert.equal(view.selectedId, "child");
});

test("left-style collapse selects the parent when the selected node is already collapsed", () => {
  const view = createTree();
  view.setRoots([ROOT]);
  view.setExpanded(["root"]);
  view.setSelectedId("child");

  const event = view.dispatch({ kind: "collapse" }, 5);
  assert.deepEqual(event, { kind: "selection", id: "root", node: ROOT });
  assert.equal(view.selectedId, "root");
});

test("expanded-node navigation selects its first child before activation", () => {
  const view = createTree();
  view.setRoots([ROOT]);
  view.setExpanded(["root"]);
  view.setSelectedId("root");

  assert.deepEqual(view.dispatch({ kind: "expand" }, 5), {
    kind: "selection",
    id: "child",
    node: ROOT.children?.[0],
  });
  assert.equal(view.dispatch({ kind: "activate" }, 5)?.kind, "activate");
});

test("rejects duplicate identities instead of producing ambiguous rows", () => {
  const view = createTree();
  assert.throws(
    () =>
      view.setRoots([
        { id: "same", label: "One" },
        { id: "same", label: "Two" },
      ]),
    /Tree node id must be unique: same/,
  );
});
