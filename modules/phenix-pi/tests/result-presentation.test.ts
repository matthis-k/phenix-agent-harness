import assert from "node:assert/strict";
import test from "node:test";

import {
  presentRootResult,
  renderContractMarkdown,
} from "../application/deterministic-presentation.ts";
import {
  projectDispatchResult,
  projectedToolResult,
} from "../application/tool-result-projection.ts";
import { type RunId, success } from "../domain/shared.ts";

function qaResult() {
  return projectedToolResult(
    projectDispatchResult({
      definition: "workflow.qa",
      selectedBy: "dispatcher",
      runId: "run-qa" as RunId,
      status: "completed",
      outcome: success({
        summary: "QA completed with one finding.",
        checks: [{ command: "devenv test", ok: true, summary: "passed" }],
        findings: [
          {
            severity: "medium",
            kind: "architecture",
            description: "A boundary needs cleanup.",
            locations: [{ path: "src/example.ts", line: 12 }],
            notes: "Keep ownership one-way.",
          },
        ],
        reports: [],
      }),
    }),
  );
}

test("auto transformation preserves canonical QA Markdown and displays it natively", () => {
  const result = presentRootResult(qaResult());

  assert.match(result.text, /^## QA report\n/);
  assert.equal(result.terminate, true);
  assert.deepEqual(
    (result.details as { transport: { presentation: unknown } }).transport.presentation,
    { transform: "markdown", display: "native" },
  );
});

test("explicit tool display keeps deterministic Markdown in the ordinary tool flow", () => {
  const result = presentRootResult(qaResult(), {
    transform: "markdown",
    display: "tool",
  });

  assert.match(result.text, /^## QA report\n/);
  assert.equal(result.terminate, undefined);
  assert.deepEqual(
    (result.details as { transport: { presentation: unknown } }).transport.presentation,
    { transform: "markdown", display: "tool" },
  );
});

test("generic contract data can be transformed into deterministic Markdown", () => {
  const result = presentRootResult(
    projectedToolResult({
      status: "success",
      summary: "Implementation completed.",
      files: [
        { path: "src/a.ts", changed: true },
        { path: "src/b.ts", changed: false },
      ],
    }),
    { transform: "markdown", display: "native" },
  );

  assert.match(result.text, /^## Result\n/);
  assert.match(result.text, /\| Field \| Value \|/);
  assert.match(result.text, /### Files/);
  assert.match(result.text, /\| path \| changed \|/);
  assert.equal(result.terminate, true);
});

test("explicit JSON transformation remains a normal tool result by default", () => {
  const result = presentRootResult(projectedToolResult({ status: "success", count: 2 }), {
    transform: "json",
  });

  assert.equal(result.text, '{\n  "status": "success",\n  "count": 2\n}');
  assert.equal(result.terminate, undefined);
  assert.deepEqual(
    (result.details as { transport: { presentation: unknown } }).transport.presentation,
    { transform: "json", display: "tool" },
  );
});

test("contract Markdown renders scalar arrays and nested objects deterministically", () => {
  const markdown = renderContractMarkdown({
    status: "success",
    tags: ["qa", "architecture"],
    metrics: { checks: 3, findings: 1 },
  });

  assert.match(markdown, /\| status \| success \|/);
  assert.match(markdown, /### Tags\n\n- qa\n- architecture/);
  assert.match(markdown, /### Metrics\n\n\| Field \| Value \|/);
});
