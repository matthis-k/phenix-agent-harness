import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  createVisualizationArtifact,
  VISUALIZATION_ENTRY_TYPE,
  VISUALIZATION_EVENT,
} from "../domain/presentation/visualization.ts";
import visualizationDisplay, { VisualizationView } from "../extension/visualization-display.ts";

class FakeTheme {
  fg(_color: string, value: string): string {
    return value;
  }
}

function artifact() {
  return createVisualizationArtifact({
    title: "Runtime boundaries",
    summary: "Shows ownership and dependency direction.",
    source: "flowchart LR\n  UI --> Application\n  Application --> Domain",
    sourceSessionId: "session-architect",
  });
}

test("published visualizations become durable Beautiful Mermaid transcript entries", () => {
  let eventHandler: ((value: unknown) => void) | undefined;
  let sessionStart: ((event: unknown, context: unknown) => void) | undefined;
  let renderer:
    | ((entry: { readonly data?: unknown }, options: unknown, theme: FakeTheme) => {
        render(width: number): string[];
      })
    | undefined;
  const appended: Array<{ readonly type: string; readonly data: unknown }> = [];

  const pi = {
    registerEntryRenderer(type: string, candidate: typeof renderer) {
      assert.equal(type, VISUALIZATION_ENTRY_TYPE);
      renderer = candidate;
    },
    events: {
      on(name: string, candidate: (value: unknown) => void) {
        assert.equal(name, VISUALIZATION_EVENT);
        eventHandler = candidate;
      },
    },
    on(name: string, candidate: (event: unknown, context: unknown) => void) {
      if (name === "session_start") sessionStart = candidate;
    },
    registerCommand() {},
    appendEntry(type: string, data: unknown) {
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;

  visualizationDisplay(pi);
  assert.ok(renderer);
  assert.ok(eventHandler);
  assert.ok(sessionStart);

  sessionStart({}, sessionContext([]));
  const visual = artifact();
  eventHandler(visual);
  eventHandler(visual);
  assert.deepEqual(appended, [{ type: VISUALIZATION_ENTRY_TYPE, data: visual }]);

  const rendered = renderer({ data: visual }, {}, new FakeTheme()).render(160).join("\n");
  assert.match(rendered, /Diagram · Runtime boundaries/);
  assert.match(rendered, /UI/);
  assert.match(rendered, /Application/);
  assert.match(rendered, /Open scrollable view: \/visual visualization-/);
});

test("root Mermaid tool results use the same persisted artifact path", () => {
  let sessionStart: ((event: unknown, context: unknown) => void) | undefined;
  let toolResult: ((event: unknown, context: unknown) => unknown) | undefined;
  const appended: Array<{ readonly type: string; readonly data: unknown }> = [];
  const pi = {
    registerEntryRenderer() {},
    events: { on() {} },
    on(name: string, candidate: (event: unknown, context: unknown) => unknown) {
      if (name === "session_start") sessionStart = candidate;
      if (name === "tool_result") toolResult = candidate;
    },
    registerCommand() {},
    appendEntry(type: string, data: unknown) {
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;

  visualizationDisplay(pi);
  assert.ok(sessionStart);
  assert.ok(toolResult);
  sessionStart({}, sessionContext([]));
  const replacement = toolResult(
    {
      toolName: "phenix_render_mermaid",
      isError: false,
      details: { source: "flowchart TD\n  A --> B" },
    },
    { mode: "tui" },
  ) as { readonly content?: readonly { readonly text?: string }[] };

  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.type, VISUALIZATION_ENTRY_TYPE);
  assert.match(replacement.content?.[0]?.text ?? "", /Published visualization/);
});

test("session startup restores visualizations from custom transcript entries", async () => {
  let sessionStart: ((event: unknown, context: unknown) => void) | undefined;
  let command: ((args: string, context: unknown) => Promise<void>) | undefined;
  const visual = artifact();
  let opened = false;
  const pi = {
    registerEntryRenderer() {},
    events: { on() {} },
    on(name: string, candidate: (event: unknown, context: unknown) => void) {
      if (name === "session_start") sessionStart = candidate;
    },
    registerCommand(name: string, input: { handler: typeof command }) {
      assert.equal(name, "visual");
      command = input.handler;
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;

  visualizationDisplay(pi);
  assert.ok(sessionStart);
  assert.ok(command);
  sessionStart(
    {},
    sessionContext([
      {
        type: "custom",
        customType: VISUALIZATION_ENTRY_TYPE,
        data: visual,
      },
    ]),
  );

  await command(visual.visualizationId.slice(-8), {
    mode: "tui",
    ui: {
      async custom(factory: (...args: never[]) => unknown) {
        opened = true;
        assert.equal(typeof factory, "function");
      },
      notify() {},
    },
  });
  assert.equal(opened, true);
});

test("the full-screen visualization view supports two-dimensional scrolling", () => {
  let renders = 0;
  let closed = false;
  const tui = {
    terminal: { rows: 10 },
    requestRender() {
      renders += 1;
    },
  };
  const view = new VisualizationView({
    tui: tui as never,
    theme: new FakeTheme() as never,
    artifact: createVisualizationArtifact({
      title: "Wide graph",
      source:
        "flowchart LR\n  A[Very wide architecture boundary] --> B[Application service] --> C[Domain model] --> D[Persistence adapter]",
      sourceSessionId: "session-architect",
    }),
    onClose: () => {
      closed = true;
    },
  });

  const initial = view.render(30);
  assert.equal(initial.length, 10);
  view.handleInput("l");
  view.handleInput("j");
  assert.equal(renders, 2);
  assert.notDeepEqual(view.render(30), initial);
  view.handleInput("q");
  assert.equal(closed, true);
});

function sessionContext(entries: readonly unknown[]): unknown {
  return {
    sessionManager: {
      getSessionId: () => "root-session",
      getBranch: () => entries,
    },
  };
}
