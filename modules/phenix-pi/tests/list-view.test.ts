import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { ListView } from "../extension/components/list-view.ts";

interface Item {
  readonly id: string;
  readonly label: string;
}

function createView(wrapNavigation = false): ListView<Item> {
  return new ListView<Item>(
    {
      id: (item) => item.id,
      render: (item, context) =>
        `${context.selected ? ">" : " "}${context.focused ? "*" : " "}${item.label}`,
    },
    { wrapNavigation },
  );
}

test("preserves selection by identity across reordered data", () => {
  const view = createView();
  view.setItems([
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
    { id: "c", label: "Gamma" },
  ]);
  view.dispatch({ kind: "move", direction: 1 }, 2);
  assert.equal(view.selectedId, "b");

  view.setItems([
    { id: "c", label: "Gamma" },
    { id: "b", label: "Beta" },
    { id: "a", label: "Alpha" },
  ]);
  assert.equal(view.selectedId, "b");

  view.setItems([
    { id: "c", label: "Gamma" },
    { id: "a", label: "Alpha" },
  ]);
  assert.equal(view.selectedId, "c");
});

test("navigation, paging, activation, and wrapping are component-local", () => {
  const view = createView(true);
  view.setItems([
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
    { id: "c", label: "Gamma" },
  ]);

  assert.equal(view.dispatch({ kind: "move", direction: -1 }, 2)?.id, "c");
  assert.equal(view.dispatch({ kind: "page", direction: -1 }, 2)?.id, "a");
  assert.deepEqual(view.dispatch({ kind: "activate" }, 2), {
    kind: "activate",
    id: "a",
    item: { id: "a", label: "Alpha" },
  });
});

test("renders an exact viewport and keeps the selected row visible", () => {
  const view = createView();
  view.setItems(
    Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      label: `item-${index}`,
    })),
  );
  view.dispatch({ kind: "edge", edge: "last" }, 3);

  const frame = view.render(8, 3, true);
  assert.equal(frame.offset, 3);
  assert.deepEqual(frame.visibleItemIds, ["3", "4", "5"]);
  assert.equal(frame.lines.length, 3);
  assert.ok(frame.lines.every((line) => visibleWidth(line) === 8));
  assert.match(frame.lines[2] ?? "", />\*item/);
});

test("uses blank filler rows after real items instead of repeating the empty state", () => {
  const view = new ListView<Item>(
    {
      id: (item) => item.id,
      render: (item) => item.label,
    },
    { renderEmpty: () => "No matching items" },
  );
  view.setItems([{ id: "a", label: "Alpha" }]);

  const frame = view.render(24, 4);
  assert.match(frame.lines[0] ?? "", /Alpha/);
  assert.equal(frame.lines.filter((line) => line.includes("No matching items")).length, 0);
  assert.ok(frame.lines.slice(1).every((line) => line.trim().length === 0));
});

test("renders the empty state once when the list is empty", () => {
  const view = new ListView<Item>(
    {
      id: (item) => item.id,
      render: (item) => item.label,
    },
    { renderEmpty: () => "No matching items" },
  );

  const frame = view.render(24, 4);
  assert.equal(frame.lines.filter((line) => line.includes("No matching items")).length, 1);
  assert.ok(frame.lines.slice(1).every((line) => line.trim().length === 0));
});
