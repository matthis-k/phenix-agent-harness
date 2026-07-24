import assert from "node:assert/strict";
import test from "node:test";

import { definitionId, localTaskId, runId } from "../domain/shared.ts";

test("runtime identifiers reject path, control, and shell metacharacters", () => {
  for (const value of ["../escape", "run/name", "run\0name", "run name", "run;name", "run$(id)"]) {
    assert.throws(() => runId(value), /unsupported characters/);
    assert.throws(() => localTaskId(value), /unsupported characters/);
  }
});

test("definition identifiers use the catalog namespace grammar", () => {
  assert.equal(definitionId("workflow.qa"), "workflow.qa");
  assert.equal(definitionId("agent.qa-synthesizer"), "agent.qa-synthesizer");
  for (const value of ["Workflow.QA", "../workflow", "workflow..qa", "workflow qa"]) {
    assert.throws(() => definitionId(value));
  }
});

test("identifiers are bounded", () => {
  assert.throws(() => runId("r".repeat(161)), /must not exceed 160/);
});
