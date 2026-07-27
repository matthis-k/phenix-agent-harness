import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extension/result-display.ts", import.meta.url), "utf8");

test("native Markdown results use Pi's Markdown component", () => {
  assert.match(source, /import \{ Markdown, Text \} from "@earendil-works\/pi-tui"/);
  assert.match(source, /data\.transform === "markdown"/);
  assert.match(source, /new Markdown\(data\.content, 1, 0, getMarkdownTheme\(\)\)/);
});

test("native JSON results use Pi's text component", () => {
  assert.match(source, /new Text\(data\.content, 1, 0\)/);
});
