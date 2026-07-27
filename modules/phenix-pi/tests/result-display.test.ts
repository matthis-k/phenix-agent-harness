import assert from "node:assert/strict";
import test from "node:test";

import { nativeResultEntry } from "../extension/result-display.ts";

const nativeMarkdownDetails = {
  status: "success",
  transport: {
    presentation: {
      transform: "markdown",
      display: "native",
    },
  },
};

test("native presentation metadata extracts a Pi display entry", () => {
  assert.deepEqual(
    nativeResultEntry({
      toolCallId: "tool-1",
      toolName: "phenix_dispatch",
      content: [{ type: "text", text: "## Result\n\nDone." }],
      details: nativeMarkdownDetails,
      isError: false,
    }),
    {
      content: "## Result\n\nDone.",
      transform: "markdown",
      toolCallId: "tool-1",
      toolName: "phenix_dispatch",
    },
  );
});

test("native JSON results use the same display entry contract", () => {
  assert.deepEqual(
    nativeResultEntry({
      toolCallId: "tool-2",
      toolName: "phenix_handle",
      content: [{ type: "text", text: '{"status":"success"}' }],
      details: {
        transport: {
          presentation: {
            transform: "json",
            display: "native",
          },
        },
      },
      isError: false,
    }),
    {
      content: '{"status":"success"}',
      transform: "json",
      toolCallId: "tool-2",
      toolName: "phenix_handle",
    },
  );
});

test("ordinary tool display and malformed metadata remain ordinary tool output", () => {
  const base = {
    toolCallId: "tool-3",
    toolName: "phenix_dispatch",
    content: [{ type: "text", text: "## Result" }],
    isError: false,
  } as const;

  assert.equal(
    nativeResultEntry({
      ...base,
      details: {
        transport: {
          presentation: {
            transform: "markdown",
            display: "tool",
          },
        },
      },
    }),
    undefined,
  );
  assert.equal(nativeResultEntry({ ...base, details: {} }), undefined);
});

test("errors and empty text never create display entries", () => {
  assert.equal(
    nativeResultEntry({
      toolCallId: "tool-4",
      toolName: "phenix_dispatch",
      content: [{ type: "text", text: "## Result" }],
      details: nativeMarkdownDetails,
      isError: true,
    }),
    undefined,
  );
  assert.equal(
    nativeResultEntry({
      toolCallId: "tool-5",
      toolName: "phenix_dispatch",
      content: [],
      details: nativeMarkdownDetails,
      isError: false,
    }),
    undefined,
  );
});
