import assert from "node:assert/strict";
import test from "node:test";

import type {
  RunImplementation,
  StartImplementationCommand,
} from "../application/execution-facade.ts";
import type { DynamicWorkflowCompositionRequest } from "../definitions/dynamic-workflow.ts";
import {
  AGENT_COORDINATOR,
  AGENT_DISPATCHER,
  AGENT_SCOUT,
  SESSION_STOCK,
  WORKFLOW_QA,
} from "../definitions/ids.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("automatic dispatch sends an unmatched one-shot task directly to the stock session", async () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  const implementation: RunImplementation = {
    async start(command: StartImplementationCommand) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
      if (command.definition.id === AGENT_DISPATCHER) {
        const candidates = (command.input as { candidates: readonly { definitionId: string }[] })
          .candidates;
        assert.ok(candidates.some((candidate) => candidate.definitionId === SESSION_STOCK));
        await runtime.controller.complete(command.runId, {
          definitionId: SESSION_STOCK,
          reason: "no specialist or workflow suits creative writing",
          confidence: 0.99,
        });
        return;
      }
      if (command.definition.id === SESSION_STOCK) {
        const input = command.input as Readonly<Record<string, unknown>>;
        assert.equal(input.task, "Tell me a short story as a test delegate");
        assert.equal(input.outputSchema, "outcome.base");
        assert.equal(typeof input.outputContract, "object");
        await runtime.controller.complete(command.runId, {
          outputSchema: "outcome.base",
          value: {
            summary: "Once upon a test.",
            artifacts: [],
            unresolved: [],
          },
        });
        return;
      }
      throw new Error(`Unexpected definition ${command.definition.id}`);
    },
  };
  runtime = await createTestRuntime(implementation);

  const result = await runtime.dispatch.dispatch(runtime.rootRunId, {
    objective: "Tell me a short story as a test delegate",
    mode: "auto",
    wait: "await",
  });

  assert.equal(result.definition, SESSION_STOCK);
  assert.equal(result.selectedBy, "dispatcher");
  assert.equal(result.status, "completed");
  assert.ok(result.classifierRunId);
  assert.equal(result.composerRunId, undefined);
  assert.deepEqual(result.outcome, {
    status: "success",
    value: { summary: "Once upon a test.", artifacts: [], unresolved: [] },
  });
  assert.deepEqual(
    runtime.store.projection.childrenOf(runtime.rootRunId).map((run) => run.definitionId),
    [AGENT_DISPATCHER, SESSION_STOCK],
  );
  assert.equal(runtime.store.projection.requireRun(result.runId).compiled.dynamicWorkflow, undefined);
});

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
  assert.equal(composerInput.workflowInputSchema, "request.objective");
  assert.ok(
    composerInput.candidates.some(
      (candidate) =>
        candidate.definitionId === AGENT_SCOUT &&
        candidate.inputSchema === "request.scout" &&
        candidate.outputSchema === "outcome.scout-report",
    ),
  );
  assert.ok(
    composerInput.candidates.some(
      (candidate) =>
        candidate.definitionId === SESSION_STOCK &&
        candidate.kind === "session" &&
        candidate.inputSchema === "request.stock-session" &&
        candidate.outputSchema === "dynamic",
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
  assert.equal(
    runtime.store.projection.requireRun(result.runId).compiled.dynamicWorkflow,
    undefined,
  );
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
