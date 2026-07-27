import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../application/agent-tools.ts", import.meta.url),
  "utf8",
);

test("dispatch and handle expose independent transform and display arguments", () => {
  assert.match(source, /transform\?: ResultTransform/);
  assert.match(source, /display\?: ResultDisplay/);
  assert.match(source, /Type\.Enum\(\["auto", "json", "markdown"\]/);
  assert.match(source, /Type\.Enum\(\["auto", "tool", "native"\]/);
  assert.match(source, /\.\.\.resultPresentationProperties/g);
});

test("completed dispatch and handle results apply presentation requests", () => {
  assert.match(
    source,
    /completionResult\(projectedToolResult\(projectDispatchResult\(result\), result\), params\)/,
  );
  assert.match(source, /presentRootResult\(result, presentation\)/);
});
