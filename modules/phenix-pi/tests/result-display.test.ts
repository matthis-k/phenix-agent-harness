import assert from "node:assert/strict";
import test from "node:test";

import { nativeResultEntry } from "../extension/result-display.ts";

const activeTools = ["read", "phenix_dispatch", "phenix_handle"];

test("Pi Markdown presentations become durable native entries", () => {
  assert.deepEqual(
    nativeResultEntry(
      {
        toolCallId: "tool-1",
        toolName: "phenix_dispatch",
        content: [{ type: "text", text: "# QA report\n\nPassed." }],
        details: {
          transport: {
            presentation: {
              transform: "qa-report",
              steps: ["qa-report-structured-content", "structured-content-markdown"],
              renderer: "pi-markdown",
              inputKind: "markdown",
            },
          },
        },
        isError: false,
      },
      activeTools,
    ),
    {
      content: "# QA report\n\nPassed.",
      inputKind: "markdown",
      renderer: "pi-markdown",
      transform: "qa-report",
      steps: ["qa-report-structured-content", "structured-content-markdown"],
      toolCallId: "tool-1",
      toolName: "phenix_dispatch",
    },
  );
});

test("generic structured documents use the same Markdown renderer", () => {
  assert.equal(
    nativeResultEntry(
      {
        toolCallId: "tool-generic",
        toolName: "phenix_dispatch",
        content: [{ type: "text", text: "# Generic" }],
        details: {
          transport: {
            presentation: {
              transform: "structured-content-markdown",
              steps: ["structured-content-contract", "structured-content-markdown"],
              renderer: "pi-markdown",
              inputKind: "markdown",
            },
          },
        },
        isError: false,
      },
      activeTools,
    )?.content,
    "# Generic",
  );
});

test("Beautiful Mermaid presentations preserve Mermaid source", () => {
  const source = "flowchart TD\n  A --> B";
  assert.deepEqual(
    nativeResultEntry(
      {
        toolCallId: "tool-2",
        toolName: "phenix_handle",
        content: [{ type: "text", text: source }],
        details: {
          transport: {
            presentation: {
              transform: "mermaid-source",
              steps: ["mermaid-source"],
              renderer: "beautiful-mermaid",
              inputKind: "mermaid",
            },
          },
        },
        isError: false,
      },
      activeTools,
    )?.content,
    source,
  );
});

test("tool rendering, child tools, errors, and incomplete metadata stay ordinary", () => {
  const toolRendered = {
    toolCallId: "tool-3",
    toolName: "phenix_dispatch",
    content: [{ type: "text", text: "# QA report" }],
    details: {
      transport: {
        presentation: {
          transform: "qa-report",
          steps: ["qa-report-structured-content", "structured-content-markdown"],
          renderer: "tool",
          inputKind: "markdown",
        },
      },
    },
    isError: false,
  };

  assert.equal(nativeResultEntry(toolRendered, activeTools), undefined);
  assert.equal(
    nativeResultEntry({ ...toolRendered, toolName: "phenix_run" }, activeTools),
    undefined,
  );
  assert.equal(nativeResultEntry({ ...toolRendered, isError: true }, activeTools), undefined);
  assert.equal(nativeResultEntry(toolRendered, ["phenix_handle"]), undefined);
  assert.equal(
    nativeResultEntry(
      {
        ...toolRendered,
        details: {
          transport: {
            presentation: {
              transform: "qa-report",
              renderer: "pi-markdown",
              inputKind: "markdown",
            },
          },
        },
      },
      activeTools,
    ),
    undefined,
  );
});
