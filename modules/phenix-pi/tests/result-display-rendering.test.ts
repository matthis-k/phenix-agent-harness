import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extension/result-display.ts", import.meta.url), "utf8");

test("native result rendering uses Pi Markdown and Beautiful Mermaid", () => {
  assert.match(source, /import \{ Markdown, Text \} from "@earendil-works\/pi-tui"/);
  assert.match(source, /new Markdown\(data\.content, 1, 0, getMarkdownTheme\(\)\)/);
  assert.match(source, /renderTerminalMermaid\(data\.content/);
});
