import assert from "node:assert/strict";
import test from "node:test";

import { WORKFLOW_IMPLEMENT, WORKFLOW_QA } from "../definitions/ids.ts";
import type { ImplementationResult, QAReport } from "../definitions/schemas.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { ModelResolutionContext, ResolvedModel } from "../domain/definition/model.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";
import type { ModelResolver } from "../ports/model-resolver.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

function recordingModelResolver(contexts: Map<string, ModelResolutionContext>): ModelResolver {
  return {
    async resolve(selector, context): Promise<ResolvedModel> {
      contexts.set(context.definitionId, context);
      return {
        requested: selector,
        concrete: { kind: "concrete", provider: "test", model: "model" },
        thinking: context.thinking === "route" ? "medium" : context.thinking,
        capability: context.capability,
        policyRevision: "test",
      };
    },
  };
}

test("implementation workflow estimates difficulty and returns verified output", async () => {
  const runtime = await createTestRuntime();
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, ImplementationResult>(WORKFLOW_IMPLEMENT),
    input: { objective: "Implement the change" },
    wait: "await",
  });
  const outcome = await handle.result();

  assert.equal(outcome.status, "success");
  if (outcome.status !== "success") return;
  assert.equal(outcome.value.attempts, 1);
  assert.equal(outcome.value.verification.accepted, true);

  const workflow = runtime.store.projection.requireRun(handle.id);
  const children = runtime.store.projection.childrenOf(handle.id);
  assert.equal(workflow.state, "completed");
  assert.deepEqual(
    children.map((child) => child.definitionId),
    ["agent.difficulty-estimator", "agent.planner", "agent.implementer", "agent.verifier"],
  );
  assert.ok(children.every((child) => child.parentId === handle.id));
});

test("D0 implementation skips planning and independent verification", async () => {
  const runtime = await createTestRuntime(undefined, { estimatedDifficulty: "D0" });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, ImplementationResult>(WORKFLOW_IMPLEMENT),
    input: { objective: "Change one obvious local constant" },
    wait: "await",
  });
  const outcome = await handle.result();

  assert.equal(outcome.status, "success");
  if (outcome.status !== "success") return;
  assert.equal(outcome.value.verification.accepted, true);
  assert.match(outcome.value.verification.summary, /targeted checks/);
  assert.deepEqual(
    runtime.store.projection.childrenOf(handle.id).map((child) => child.definitionId),
    ["agent.difficulty-estimator", "agent.implementer"],
  );
});

test("estimated difficulty selects Markdown-declared model routes", async () => {
  const contexts = new Map<string, ModelResolutionContext>();
  const runtime = await createTestRuntime(undefined, {
    estimatedDifficulty: "D2",
    modelResolver: recordingModelResolver(contexts),
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, ImplementationResult>(WORKFLOW_IMPLEMENT),
    input: { objective: "Coordinate a cross-module change" },
    wait: "await",
  });
  assert.equal((await handle.result()).status, "success");

  assert.deepEqual(
    {
      difficulty: contexts.get("agent.planner")?.difficulty,
      capability: contexts.get("agent.planner")?.capability,
      thinking: contexts.get("agent.planner")?.thinking,
    },
    { difficulty: "D2", capability: "reasoning", thinking: "high" },
  );
  assert.deepEqual(
    {
      difficulty: contexts.get("agent.implementer")?.difficulty,
      capability: contexts.get("agent.implementer")?.capability,
      thinking: contexts.get("agent.implementer")?.thinking,
    },
    { difficulty: "D2", capability: "code", thinking: "medium" },
  );
  assert.deepEqual(
    {
      difficulty: contexts.get("agent.verifier")?.difficulty,
      capability: contexts.get("agent.verifier")?.capability,
      thinking: contexts.get("agent.verifier")?.thinking,
    },
    { difficulty: "D2", capability: "review", thinking: "high" },
  );
});

test("implementation workflow performs a bounded typed repair loop", async () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  let verifications = 0;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
      if (command.definition.id === "agent.difficulty-estimator") {
        await runtime.controller.complete(command.runId, {
          difficulty: "D1",
          summary: "bounded test task",
          signals: ["repair loop fixture"],
        });
        return;
      }
      if (command.definition.id === "agent.planner") {
        await runtime.controller.complete(command.runId, {
          summary: "plan",
          steps: ["edit"],
          constraints: [],
          checks: ["test"],
        });
        return;
      }
      if (command.definition.id === "agent.implementer") {
        await runtime.controller.complete(command.runId, {
          summary: "implemented",
          changedFiles: ["src/file.ts"],
          checks: [{ command: "test", ok: true, summary: "passed" }],
          unresolved: [],
        });
        return;
      }
      assert.equal(command.definition.id, "agent.verifier");
      verifications += 1;
      await runtime.controller.complete(command.runId, {
        accepted: verifications > 1,
        summary: verifications > 1 ? "accepted" : "repair required",
        findings: verifications > 1 ? [] : ["fix regression"],
        evidence: ["test output"],
      });
    },
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, ImplementationResult>(WORKFLOW_IMPLEMENT),
    input: { objective: "repair once" },
    wait: "await",
  });
  const outcome = await handle.result();
  assert.equal(outcome.status, "success");
  if (outcome.status !== "success") return;
  assert.equal(outcome.value.attempts, 2);
  assert.equal(verifications, 2);
});

test("QA workflow pins capable review routes independent of session difficulty", async () => {
  const contexts = new Map<string, ModelResolutionContext>();
  const runtime = await createTestRuntime(undefined, {
    modelResolver: recordingModelResolver(contexts),
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, QAReport>(WORKFLOW_QA),
    input: { objective: "Audit the repository" },
    wait: "await",
  });
  const outcome = await handle.result();
  assert.equal(outcome.status, "success");
  const children = runtime.store.projection.childrenOf(handle.id);
  assert.deepEqual(
    children.map((child) => child.definitionId).sort(),
    [
      "agent.architect",
      "agent.critic",
      "agent.qa-synthesizer",
      "agent.scout",
      "agent.tester",
    ].sort(),
  );
  assert.equal(contexts.get("agent.scout")?.difficulty, "D2");
  assert.equal(contexts.get("agent.tester")?.difficulty, "D2");
  assert.equal(contexts.get("agent.architect")?.difficulty, "D3");
  assert.equal(contexts.get("agent.architect")?.capability, "reasoning-max");
  assert.equal(contexts.get("agent.critic")?.difficulty, "D3");
  assert.equal(contexts.get("agent.critic")?.capability, "review-max");
  assert.equal(contexts.get("agent.qa-synthesizer")?.difficulty, "D3");
  assert.equal(contexts.get("agent.qa-synthesizer")?.capability, "review-max");
  assert.ok(
    runtime.store.projection
      .eventsFor(handle.id)
      .some(
        (event) =>
          event.type === "workflow.node.completed" &&
          (event.data as { nodeId?: string }).nodeId === "checks",
      ),
  );
});

test("workflow cancellation aborts and joins owned local operations", async () => {
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  const operations: LocalOperationRunner = {
    has: (operation) => operation === "local.noop" || operation === "local.qa-checks",
    async run(operation, input, context) {
      if (operation !== "local.noop") return input;
      observedSignal = context.signal;
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener(
          "abort",
          () => reject(context.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
  };
  const runtime = await createTestRuntime(undefined, { operations });
  const starting = runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_QA),
    input: { objective: "cancel during local work" },
    wait: "await",
  });
  await started;
  const workflow = [...runtime.store.projection.runs.values()].find(
    (run) => run.definitionId === WORKFLOW_QA,
  );
  assert.ok(workflow);

  await runtime.execution.cancel(workflow.id, "user cancelled");
  const handle = await starting;
  assert.equal(observedSignal?.aborted, true);
  assert.equal(runtime.store.projection.requireRun(handle.id).state, "cancelled");
});

test("a coordinator composes QA and implementation as sibling runs instead of a wrapper workflow", async () => {
  const runtime = await createTestRuntime();
  const qa = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, QAReport>(WORKFLOW_QA),
    input: { objective: "Audit before deciding whether to edit" },
    wait: "await",
  });
  assert.equal((await qa.result()).status, "success");

  const implementation = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, ImplementationResult>(WORKFLOW_IMPLEMENT),
    input: {
      objective: "Address the actionable QA findings",
      findings: ["example actionable finding selected by the coordinator"],
    },
    wait: "await",
  });
  assert.equal((await implementation.result()).status, "success");

  const rootChildren = runtime.store.projection.childrenOf(runtime.rootRunId);
  assert.deepEqual(
    rootChildren.map((run) => run.definitionId),
    [WORKFLOW_QA, WORKFLOW_IMPLEMENT],
  );
  assert.ok(rootChildren.every((run) => run.parentId === runtime.rootRunId));
  assert.equal(
    [...runtime.store.projection.runs.values()].some(
      (run) => run.definitionId === "workflow.qa-and-fix",
    ),
    false,
  );
});
