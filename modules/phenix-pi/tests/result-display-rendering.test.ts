import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extension/result-display.ts", import.meta.url), "utf8");

test("native result rendering uses injected Pi Markdown and Beautiful Mermaid strategies", () => {
  assert.match(source, /defaultNativeResultRenderers/);
  assert.match(source, /registerResultDisplay\(pi, \{ renderers: defaultNativeResultRenderers \}\)/);
  assert.match(source, /new Markdown\(content, 1, 0, getMarkdownTheme\(\)\)/);
  assert.match(source, /renderTerminalMermaid\(content/);
  assert.match(source, /renderer\.render\(data\.content, theme\)/);
});
