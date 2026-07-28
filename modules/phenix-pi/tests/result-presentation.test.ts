import assert from "node:assert/strict";
import test from "node:test";
import { qaReportDocument } from "../application/qa-report-structured-content.ts";
import {
  composeResultTransformStrategy,
  createResultPresenter,
  presentRootResult,
  type ResultTransformStep,
  transformResult,
} from "../application/result-presentation.ts";
import { renderStructuredContentMarkdown } from "../application/structured-content-markdown.ts";
import {
  projectDispatchResult,
  projectedToolResult,
} from "../application/tool-result-projection.ts";
import { type RunId, success } from "../domain/shared.ts";

function qaContract() {
  return {
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
  };
}

function qaResult() {
  return projectedToolResult(
    projectDispatchResult({
      definition: "workflow.qa",
      selectedBy: "dispatcher",
      runId: "run-qa" as RunId,
      status: "completed",
      outcome: success(qaContract()),
    }),
  );
}

test("QA presentation composes contract to structured content to Markdown", () => {
  const document = qaReportDocument(qaContract());
  const transformed = transformResult(qaResult(), "qa-report");
  const presented = presentRootResult({ ...qaResult(), text: "raw transport text" });

  assert.equal(document?.contentType, "document");
  assert.equal(document?.content, "QA report");
  assert.deepEqual(transformed?.steps, [
    "qa-report-structured-content",
    "structured-content-markdown",
  ]);
  assert.equal(transformed?.input.kind, "markdown");
  assert.match(
    transformed?.input.kind === "markdown" ? transformed.input.content : "",
    /^# QA report/m,
  );
  assert.equal(presented.terminate, true);
  assert.match(presented.text, /^# QA report/m);
  assert.deepEqual(
    (presented.details as { transport: { presentation: unknown } }).transport.presentation,
    {
      transform: "qa-report",
      steps: ["qa-report-structured-content", "structured-content-markdown"],
      renderer: "pi-markdown",
      inputKind: "markdown",
    },
  );
});

test("generic structured content derives heading and list depth", () => {
  const markdown = renderStructuredContentMarkdown({
    contentType: "document",
    content: "Report",
    children: [
      {
        contentType: "section",
        content: "Parent",
        children: [
          {
            contentType: "section",
            content: "Child",
            children: [
              {
                contentType: "ordered-list",
                children: [
                  { contentType: "list-item", content: "First" },
                  {
                    contentType: "list-item",
                    content: "Second",
                    children: [
                      {
                        contentType: "unordered-list",
                        children: [{ contentType: "list-item", content: "Nested" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  assert.match(markdown, /^# Report/m);
  assert.match(markdown, /^## Parent/m);
  assert.match(markdown, /^### Child/m);
  assert.match(markdown, /^1\. First/m);
  assert.match(markdown, /^2\. Second/m);
  assert.match(markdown, /^ {2}- Nested/m);
  assert.doesNotMatch(markdown, /^0\./m);
});

test("a structured document can use the generic transform directly", () => {
  const result = {
    text: "raw",
    details: {
      contentType: "document",
      content: "Generic",
      children: [{ contentType: "paragraph", content: "Body" }],
    },
  };
  const presented = presentRootResult(result);

  assert.equal(presented.terminate, true);
  assert.equal(presented.text, "# Generic\n\nBody");
  assert.deepEqual(
    (presented.details as { transport: { presentation: unknown } }).transport.presentation,
    {
      transform: "structured-content-markdown",
      steps: ["structured-content-contract", "structured-content-markdown"],
      renderer: "pi-markdown",
      inputKind: "markdown",
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

test("transform and renderer strategies are dependency-injected", () => {
  const step: ResultTransformStep = {
    id: "injected-contract-markdown",
    inputKind: "contract",
    outputKind: "markdown",
    transform: () => ({ kind: "markdown", content: "injected" }),
  };
  const presenter = createResultPresenter({
    transforms: [composeResultTransformStrategy({ id: "qa-report", auto: true, steps: [step] })],
    renderers: [
      {
        id: "tool",
        auto: true,
        native: false,
        accepts: (input) => input.kind === "markdown",
      },
    ],
  });

  assert.deepEqual(presenter({ text: "original", details: {} }), {
    text: "injected",
    details: {
      transport: {
        presentation: {
          transform: "qa-report",
          steps: ["injected-contract-markdown"],
          renderer: "tool",
          inputKind: "markdown",
        },
      },
    },
  });
});

test("ordinary results remain unchanged when no automatic transform matches", () => {
  const result = {
    text: JSON.stringify({ status: "success", summary: "ordinary" }),
    details: { status: "success", summary: "ordinary" },
  };

  assert.strictEqual(presentRootResult(result), result);
});
