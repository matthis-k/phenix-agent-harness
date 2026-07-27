import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../application/agent-tools.ts", import.meta.url), "utf8");

test("dispatch and handle expose named transforms and renderers", () => {
  assert.match(source, /Type\.Enum\(\["auto", "qa-report", "mermaid-source"\]/);
  assert.match(source, /Type\.Enum\(\["auto", "tool", "pi-markdown", "beautiful-mermaid"\]/);
  assert.match(source, /transform\?: ResultTransform/);
  assert.match(source, /renderer\?: ResultRenderer/);
  assert.doesNotMatch(source, /"json", "markdown"/);
});
