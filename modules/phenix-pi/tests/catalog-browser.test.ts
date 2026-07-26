import assert from "node:assert/strict";
import test from "node:test";

import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { AnyDefinition } from "../domain/definition/definition.ts";
import { CatalogBrowser } from "../extension/catalog-browser.ts";
import type { ObservabilityTheme } from "../extension/observability-theme.ts";

const theme = {
  fg: (_tone: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ObservabilityTheme;

test("catalog browser fills the terminal and never wraps preview lines", () => {
  const tui = fakeTui(18);
  const browser = new CatalogBrowser({
    tui,
    theme,
    definitions: [workflowDefinition("workflow.long", "0123456789".repeat(30))],
    onClose: () => undefined,
  });

  const lines = browser.render(72);
  assert.equal(lines.length, 18);
  assert.ok(lines.every((line) => visibleWidth(line) === 72));
  assert.equal(lines.filter((line) => line.includes("0123456789")).length, 1);
});

test("catalog browser horizontally pans the no-wrap preview", () => {
  const tui = fakeTui(12);
  const browser = new CatalogBrowser({
    tui,
    theme,
    definitions: [workflowDefinition("workflow.long", `START-${"x".repeat(180)}-END`)],
    onClose: () => undefined,
  });

  const initial = browser.render(60).join("\n");
  assert.match(initial, /START-/);

  browser.handleInput("\t");
  for (let index = 0; index < 20; index += 1) browser.handleInput("\x1b[C");
  const shifted = browser.render(60).join("\n");
  assert.doesNotMatch(shifted, /START-/);
  assert.ok(tui.renderRequests > 0);
});

test("catalog browser sidebar selection changes the preview and escape closes", () => {
  const tui = fakeTui(14);
  let closed = false;
  const browser = new CatalogBrowser({
    tui,
    theme,
    definitions: [
      workflowDefinition("workflow.first", "First definition"),
      workflowDefinition("workflow.second", "Second definition"),
    ],
    onClose: () => {
      closed = true;
    },
  });

  assert.match(browser.render(80).join("\n"), /workflow\.first/);
  browser.handleInput("\x1b[B");
  assert.match(browser.render(80).join("\n"), /workflow\.second/);
  browser.handleInput("\x1b");
  assert.equal(closed, true);
});

function fakeTui(rows: number): TUI & { renderRequests: number } {
  return {
    terminal: { rows },
    renderRequests: 0,
    requestRender() {
      this.renderRequests += 1;
    },
  } as unknown as TUI & { renderRequests: number };
}

function workflowDefinition(id: string, description: string): AnyDefinition {
  return {
    id,
    kind: "workflow",
    title: id,
    description,
    input: { id: `${id}.input` },
    output: { id: `${id}.output` },
    graph: {
      entry: "start",
      nodes: [
        {
          kind: "invoke",
          id: "start",
          title: "Start",
          definition: { id: "agent.scout" },
          input: "test.input",
          wait: "await",
        },
        { kind: "return", id: "done", title: "Done", output: "test.output" },
      ],
      edges: [{ from: "start", to: "done" }],
    },
    limits: { timeoutMs: 1_000, maxNodeRuns: 2, maxParallelism: 1 },
  } as unknown as AnyDefinition;
}
