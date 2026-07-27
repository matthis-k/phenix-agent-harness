import assert from "node:assert/strict";
import test from "node:test";

import { deterministicQaReportEntry } from "../extension/deterministic-report-viewer.ts";

const canonicalReport = [
  "## QA report",
  "",
  "**Gate status:** Passed",
  "",
  "### Deterministic checks",
  "",
  "| Check | Status | Details |",
  "|---|---|---|",
  "| devenv test | PASSED | passed |",
  "",
  "### Findings",
  "",
  "| # | Severity | Kind | Description | Locations | Notes |",
  "|---:|---|---|---|---|---|",
  "| — | — | — | No review findings were reported. | — | — |",
].join("\n");

const structuredDetails = {
  definition: "workflow.qa",
  status: "completed",
  outcome: {
    status: "success",
    checks: [{ command: "devenv test", ok: true, summary: "passed" }],
    findings: [],
  },
};

test("canonical root QA output is extracted for the native Markdown entry", () => {
  assert.deepEqual(
    deterministicQaReportEntry(
      {
        toolCallId: "tool-1",
        toolName: "phenix_dispatch",
        content: [{ type: "text", text: canonicalReport }],
        details: structuredDetails,
        isError: false,
      },
      ["read", "phenix_dispatch", "phenix_handle"],
    ),
    {
      markdown: canonicalReport,
      toolCallId: "tool-1",
      toolName: "phenix_dispatch",
    },
  );
});

test("completed root handle results support flat structured details", () => {
  assert.ok(
    deterministicQaReportEntry(
      {
        toolCallId: "tool-2",
        toolName: "phenix_handle",
        content: [{ type: "text", text: canonicalReport }],
        details: {
          status: "success",
          checks: [],
          findings: [],
        },
        isError: false,
      },
      ["phenix_dispatch", "phenix_handle"],
    ),
  );
});

test("ordinary Markdown and child tool results remain ordinary tool output", () => {
  const ordinary = {
    toolCallId: "tool-3",
    toolName: "phenix_handle",
    content: [{ type: "text", text: "## QA report\n\nUnstructured prose." }],
    details: { status: "success", summary: "No structured collections" },
    isError: false,
  };

  assert.equal(
    deterministicQaReportEntry(ordinary, ["phenix_dispatch", "phenix_handle"]),
    undefined,
  );
  assert.equal(deterministicQaReportEntry(ordinary, ["phenix_handle"]), undefined);
});

test("errors and unrelated tools never create report entries", () => {
  assert.equal(
    deterministicQaReportEntry(
      {
        toolCallId: "tool-4",
        toolName: "phenix_dispatch",
        content: [{ type: "text", text: canonicalReport }],
        details: structuredDetails,
        isError: true,
      },
      ["phenix_dispatch"],
    ),
    undefined,
  );
  assert.equal(
    deterministicQaReportEntry(
      {
        toolCallId: "tool-5",
        toolName: "read",
        content: [{ type: "text", text: canonicalReport }],
        details: structuredDetails,
        isError: false,
      },
      ["phenix_dispatch", "read"],
    ),
    undefined,
  );
});
