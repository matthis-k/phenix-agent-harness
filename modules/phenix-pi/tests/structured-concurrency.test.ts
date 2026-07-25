import assert from "node:assert/strict";
import test from "node:test";
import type { RunImplementation } from "../application/execution-facade.ts";
import { genericWriteDefinition } from "../definitions/agents.ts";
import { AGENT_GENERIC_WRITE, WORKFLOW_IMPLEMENT } from "../definitions/ids.ts";
import { definitionRef, type AgentDefinition } from "../domain/definition/definition.ts";
import { definitionId, type RunId } from "../domain/shared.ts";
import type { ModelResolver } from "../ports/model-resolver.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

const TEST_PARENT = definitionId("agent.test-structured-parent");
const testParentDefinition: AgentDefinition<unknown, unknown> = {
  ...genericWriteDefinition,
  id: TEST_PARENT,
  title: "Structured concurrency test parent",
  description: "Test-only parent with one explicit child capability.",
  tools: { allow: [] },
  childCapabilities: {
    invokableDefinitions: [AGENT_GENERIC_WRITE],
    maxDepth: 4,
    mayDetach: true,
    maySend: false,
    mayCancelChildren: true,
  },
};

const genericInput = (objective: string) => ({
  objective,
  instructions: "Remain active for structured-concurrency assertions.",
});

test("background changes waiting but does not detach ownership", async () => {
  let implementation: PendingImplementation | undefined;
  const runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
    async cancel(runId) {
      implementation?.cancelled.push(runId);
    },
  });
  implementation = new PendingImplementation();

  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_GENERIC_WRITE),
    input: genericInput("background work"),
    wait: "background",
  });
  const child = runtime.store.projection.requireRun(handle.id);
  assert.equal(child.ownership, "attached");
  assert.equal(child.parentId, runtime.rootRunId);

  await runtime.execution.cancel(runtime.rootRunId, "stop all work");
  assert.equal(runtime.store.projection.requireRun(handle.id).state, "cancelled");
  assert.equal(runtime.store.projection.requireRun(runtime.rootRunId).state, "cancelled");
});

test("explicit reparenting transfers a child to the root supervisor", async () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  runtime = await createTestRuntime(
    {
      async start(command) {
        await runtime.controller.transition(command.runId, "starting");
        await runtime.controller.transition(command.runId, "running");
      },
    },
    { definitions: [testParentDefinition], rootInvokableDefinitions: [TEST_PARENT] },
  );
  const parent = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(TEST_PARENT),
    input: genericInput("parent"),
    wait: "background",
  });
  const child = await runtime.execution.start({
    parentId: parent.id,
    definition: definitionRef(AGENT_GENERIC_WRITE),
    input: genericInput("child"),
    wait: "background",
  });

  await runtime.execution.reparent(child.id, runtime.rootRunId);
  assert.equal(runtime.store.projection.requireRun(child.id).parentId, runtime.rootRunId);
  assert.equal(runtime.store.projection.requireRun(child.id).ownership, "detached");

  await runtime.execution.cancel(parent.id, "parent finished");
  assert.equal(runtime.store.projection.requireRun(child.id).state, "running");
  await runtime.execution.cancel(runtime.rootRunId, "supervisor shutdown");
  assert.equal(runtime.store.projection.requireRun(child.id).state, "cancelled");
});

test("model resolution failure is a typed terminal run outcome", async () => {
  const modelResolver: ModelResolver = {
    async resolve() {
      throw new Error("no authenticated model");
    },
  };
  const runtime = await createTestRuntime(
    {
      async start() {
        throw new Error("backend must not start without a model");
      },
    },
    { modelResolver },
  );
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_GENERIC_WRITE),
    input: genericInput("requires a model"),
    wait: "await",
  });
  const outcome = await handle.result();
  assert.equal(outcome.status, "failure");
  if (outcome.status === "failure") {
    assert.equal(outcome.failure.code, "model_unavailable");
  }
  assert.equal(runtime.store.projection.requireRun(handle.id).state, "failed");
});

test("an invocation resolving its model cannot attach after parent cancellation starts", async () => {
  let releaseModel: () => void = () => undefined;
  let markResolving: () => void = () => undefined;
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const resolving = new Promise<void>((resolve) => {
    markResolving = resolve;
  });
  let resolutions = 0;
  const modelResolver: ModelResolver = {
    async resolve(selector, context) {
      resolutions += 1;
      if (resolutions === 2) {
        markResolving();
        await modelGate;
      }
      return {
        requested: selector,
        concrete: { kind: "concrete", provider: "test", model: "model" },
        thinking: context.thinking === "route" ? "medium" : context.thinking,
        policyRevision: "test",
      };
    },
  };
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  runtime = await createTestRuntime(
    {
      async start(command) {
        await runtime.controller.transition(command.runId, "starting");
        await runtime.controller.transition(command.runId, "running");
      },
    },
    {
      modelResolver,
      definitions: [testParentDefinition],
      rootInvokableDefinitions: [TEST_PARENT],
    },
  );
  const parent = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(TEST_PARENT),
    input: genericInput("parent"),
    wait: "background",
  });
  const childStart = runtime.execution.start({
    parentId: parent.id,
    definition: definitionRef(AGENT_GENERIC_WRITE),
    input: genericInput("late child"),
    wait: "background",
  });
  await resolving;

  const cancellation = runtime.execution.cancel(parent.id, "stop parent");
  releaseModel();
  await cancellation;
  await assert.rejects(childStart, /Cannot start a child/);
  assert.equal(runtime.store.projection.childrenOf(parent.id).length, 0);
  assert.equal(runtime.store.projection.requireRun(parent.id).state, "cancelled");
});

test("parent cancellation wins over child terminal reactions", async () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  runtime = await createTestRuntime({
    async start(command) {
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");
    },
  });
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_IMPLEMENT),
    input: { objective: "cancel this workflow" },
    wait: "await",
  });

  await runtime.execution.cancel(handle.id, "user cancelled workflow");
  await runtime.store.events.drain();
  const outcome = runtime.store.projection.requireRun(handle.id).outcome;
  assert.equal(outcome?.status, "cancelled");
});

class PendingImplementation implements RunImplementation {
  readonly cancelled: RunId[] = [];
  async start(): Promise<void> {}
}
