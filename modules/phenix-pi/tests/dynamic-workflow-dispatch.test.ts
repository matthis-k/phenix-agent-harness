import assert from "node:assert/strict";
import test from "node:test";

import type { DynamicWorkflowCompositionRequest } from "../definitions/dynamic-workflow.ts";
import {
  AGENT_COORDINATOR,
  AGENT_DISPATCHER,
  AGENT_SCOUT,
  WORKFLOW_QA,
} from "../definitions/ids.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("automatic dispatch composes and executes a sealed workflow only as the fallback", async () => {
  const runtime = await createTestRuntime();

  const result = await runtime.dispatch.dispatch(runtime.rootRunId, {
    objective: "Answer an open-ended repository question that needs custom composition",
    context: { focus: "runtime" },
    mode: "auto",
    wait: "await",
  });

  assert.equal(result.selectedBy, "dispatcher");
  assert.equal(result.status, "completed");
  assert.match(result.definition, /^workflow\.dynamic\.[a-f0-9]{24}$/);
  assert.ok(result.classifierRunId);
  assert.ok(result.composerRunId);
  assert.deepEqual(result.outcome, {
    status: "success",
    value: {
      summary: "scouted",
      evidence: [{ path: "src/file.ts", finding: "ok" }],
      risks: [],
    },
  });

  const classifier = runtime.store.projection.requireRun(result.classifierRunId);
  const composer = runtime.store.projection.requireRun(result.composerRunId);
  const dynamic = runtime.store.projection.requireRun(result.runId);
  const composerInput = composer.input as DynamicWorkflowCompositionRequest;

  assert.equal(classifier.definitionId, AGENT_DISPATCHER);
  assert.equal(composer.definitionId, AGENT_COORDINATOR);
  assert.deepEqual(composer.compiled.tools, []);
  assert.equal(runtime.store.projection.childrenOf(composer.id).length, 0);
  assert.equal(composerInput.workflowInputSchema, "request.objective.v1");
  assert.ok(
    composerInput.candidates.some(
      (candidate) =>
        candidate.definitionId === AGENT_SCOUT &&
        candidate.inputSchema === "request.scout.v1" &&
        candidate.outputSchema === "outcome.scout-report.v1",
    ),
  );
  assert.ok(dynamic.compiled.dynamicWorkflow);
  assert.deepEqual(dynamic.compiled.capabilities.invokableDefinitions, [AGENT_SCOUT]);
  assert.equal(runtime.store.projection.childrenOf(dynamic.id)[0]?.definitionId, AGENT_SCOUT);
});

test("explicit QA bypasses the dynamic composer", async () => {
  const runtime = await createTestRuntime();

  const result = await runtime.dispatch.dispatch(runtime.rootRunId, {
    objective: "Run full repository QA",
    mode: "qa",
    wait: "await",
  });

  assert.equal(result.definition, WORKFLOW_QA);
  assert.equal(result.selectedBy, "explicit");
  assert.equal(result.status, "completed");
  assert.equal(result.classifierRunId, undefined);
  assert.equal(result.composerRunId, undefined);
  assert.equal(runtime.store.projection.requireRun(result.runId).compiled.dynamicWorkflow, undefined);
  assert.equal(
    runtime.store.projection
      .childrenOf(runtime.rootRunId)
      .some((run) => run.definitionId === AGENT_COORDINATOR),
    false,
  );
});

test("explicit coordinate waits for graph composition and then starts the dynamic run", async () => {
  const runtime = await createTestRuntime();

  const result = await runtime.dispatch.dispatch(runtime.rootRunId, {
    objective: "Compose a focused repository investigation",
    mode: "coordinate",
    wait: "background",
  });

  assert.equal(result.selectedBy, "explicit");
  assert.equal(result.status, "running");
  assert.equal(result.classifierRunId, undefined);
  assert.ok(result.composerRunId);
  assert.match(result.definition, /^workflow\.dynamic\.[a-f0-9]{24}$/);
  assert.equal(runtime.store.projection.requireRun(result.composerRunId).state, "completed");
  assert.ok(runtime.store.projection.requireRun(result.runId).compiled.dynamicWorkflow);
});
