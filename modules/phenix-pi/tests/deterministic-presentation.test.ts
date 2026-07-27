import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeRootPresentation,
  isDeterministicQaPresentation,
} from "../application/deterministic-presentation.ts";
import {
  projectDispatchResult,
  projectedToolResult,
} from "../application/tool-result-projection.ts";
import { type RunId, success } from "../domain/shared.ts";

test("a deterministic QA report terminates the root frontend turn", () => {
  const result = projectedToolResult(
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

  assert.equal(isDeterministicQaPresentation(result), true);
  assert.deepEqual(finalizeRootPresentation(result), { ...result, terminate: true });
});

test("ordinary tool text cannot terminate the frontend turn", () => {
  const result = {
    text: "## QA report\n\nThis heading came from ordinary text.",
    details: {
      status: "success",
      summary: "No structured report is present.",
    },
  };

  assert.equal(isDeterministicQaPresentation(result), false);
  assert.strictEqual(finalizeRootPresentation(result), result);
});
