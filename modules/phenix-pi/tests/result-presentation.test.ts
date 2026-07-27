import assert from "node:assert/strict";
import test from "node:test";

import {
  isDeterministicQaPresentation,
  presentRootResult,
  transformResult,
} from "../application/result-presentation.ts";
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

test("auto selects the QA transform and Pi Markdown renderer", () => {
  const result = qaResult();
  const presented = presentRootResult(result);

  assert.equal(isDeterministicQaPresentation(result), true);
  assert.equal(presented.terminate, true);
  assert.match(presented.text, /^## QA report/);
  assert.deepEqual(
    (presented.details as { transport: { presentation: unknown } }).transport.presentation,
    {
      transform: "qa-report",
      renderer: "pi-markdown",
      inputKind: "markdown",
    },
  );
});

test("the QA transform generates Markdown from contract data", () => {
  const result = { ...qaResult(), text: "raw transport text" };
  const transformed = transformResult(result, "qa-report");

  assert.equal(isDeterministicQaPresentation(result), true);
  assert.equal(transformed?.input.kind, "markdown");
  assert.match(
    transformed?.input.kind === "markdown" ? transformed.input.content : "",
    /^## QA report/,
  );
});

test("the QA transform can keep Markdown in the ordinary tool result", () => {
  const presented = presentRootResult(qaResult(), {
    transform: "qa-report",
    renderer: "tool",
  });

  assert.equal(presented.terminate, undefined);
  assert.match(presented.text, /^## QA report/);
});

test("the Mermaid source transform feeds the Beautiful Mermaid renderer", () => {
  const source = "flowchart TD\n  A --> B";
  const result = {
    text: JSON.stringify({ source }),
    details: { source, transport: { sourceBytes: 32, inlineBytes: 32, omittedBytes: 0 } },
  };
  const transformed = transformResult(result, "mermaid-source");
  const presented = presentRootResult(result, {
    transform: "mermaid-source",
    renderer: "beautiful-mermaid",
  });

  assert.deepEqual(transformed, {
    id: "mermaid-source",
    input: { kind: "mermaid", source },
  });
  assert.equal(presented.text, source);
  assert.equal(presented.terminate, true);
  assert.deepEqual(
    (presented.details as { transport: { presentation: unknown } }).transport.presentation,
    {
      transform: "mermaid-source",
      renderer: "beautiful-mermaid",
      inputKind: "mermaid",
    },
  );
});

test("renderer compatibility is enforced", () => {
  assert.throws(
    () =>
      presentRootResult(qaResult(), {
        transform: "qa-report",
        renderer: "beautiful-mermaid",
      }),
    /cannot render markdown input/,
  );
});

test("ordinary results remain unchanged when no automatic transform matches", () => {
  const result = {
    text: JSON.stringify({ status: "success", summary: "ordinary" }),
    details: { status: "success", summary: "ordinary" },
  };

  assert.strictEqual(presentRootResult(result), result);
});
