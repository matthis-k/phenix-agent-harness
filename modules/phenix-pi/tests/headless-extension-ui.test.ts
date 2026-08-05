import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { HeadlessExtensionUi, type HeadlessExtensionUiEvent } from "../headless/extension-ui.ts";

type ExtensionTheme = ExtensionUIContext["theme"];

test("extension selector is rendered externally and resolved by dialog identity", async () => {
  const events: HeadlessExtensionUiEvent[] = [];
  const ui = createUi(events);

  const selection = ui.context.select("Choose provider", ["OpenAI", "Anthropic"]);
  assert.deepEqual(events[0], {
    type: "extension_ui.requested",
    dialogId: "dialog-1",
    request: {
      kind: "select",
      title: "Choose provider",
      options: ["OpenAI", "Anthropic"],
    },
  });

  ui.respond("dialog-1", { kind: "selected", value: "OpenAI" });
  assert.equal(await selection, "OpenAI");
});

test("dialog abort emits cancellation and resolves the Pi-compatible default", async () => {
  const events: HeadlessExtensionUiEvent[] = [];
  const ui = createUi(events);
  const controller = new AbortController();

  const confirmed = ui.context.confirm("Delete?", "This cannot be undone", {
    signal: controller.signal,
  });
  controller.abort();

  assert.equal(await confirmed, false);
  assert.ok(events.some((event) => event.type === "extension_ui.cancelled"));
});

test("editor and status mutations remain semantic frontend events", () => {
  const events: HeadlessExtensionUiEvent[] = [];
  const ui = createUi(events);

  ui.context.setEditorText("base");
  ui.context.pasteToEditor(" + pasted");
  ui.context.setStatus("memory", "ready");
  ui.context.setStatus("memory", undefined);

  assert.equal(ui.context.getEditorText(), "base + pasted");
  assert.deepEqual(events, [
    { type: "editor.replace", text: "base" },
    { type: "editor.paste", text: " + pasted" },
    { type: "status.changed", key: "memory", text: "ready" },
    { type: "status.changed", key: "memory" },
  ]);
});

test("Pi component factories are reported as unsupported instead of crossing the boundary", () => {
  const events: HeadlessExtensionUiEvent[] = [];
  const ui = createUi(events);

  ui.context.setFooter(undefined);
  ui.context.setHeader(undefined);
  ui.context.setEditorComponent(undefined);

  assert.deepEqual(
    events.map((event) => (event.type === "extension_ui.unsupported" ? event.feature : undefined)),
    ["custom footer component", "custom header component", "custom Pi editor component"],
  );
});

function createUi(events: HeadlessExtensionUiEvent[]): HeadlessExtensionUi {
  let nextId = 1;
  const theme = {} as ExtensionTheme;
  return new HeadlessExtensionUi({
    publish: (event) => events.push(event),
    createId: () => `dialog-${nextId++}`,
    themes: {
      current: theme,
      list: () => [],
      get: () => undefined,
      set: () => ({ success: false, error: "not available" }),
    },
  });
}
