import assert from "node:assert/strict";
import test from "node:test";

import type {
  RunController,
  RunImplementation,
  StartImplementationCommand,
} from "../application/execution-facade.ts";
import { ModelExecutionFacade } from "../application/model-execution-facade.ts";
import { AGENT_BASE } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

class PendingAgent implements RunImplementation {
  private controller?: RunController;

  bind(controller: RunController): void {
    this.controller = controller;
  }

  async start(command: StartImplementationCommand): Promise<void> {
    if (!this.controller) throw new Error("Pending agent is not bound");
    await this.controller.transition(command.runId, "starting");
    await this.controller.transition(command.runId, "running");
  }
}

test("model execution facade rejects every handle path for internal definitions", async () => {
  const agents = new PendingAgent();
  const runtime = await createTestRuntime(agents, {
    rootInvokableDefinitions: [AGENT_BASE],
  });
  agents.bind(runtime.controller);
  const modelExecution = new ModelExecutionFacade({
    execution: runtime.execution,
    store: runtime.store,
    hiddenDefinitions: [AGENT_BASE],
  });

  assert.throws(
    () =>
      modelExecution.start({
        parentId: runtime.rootRunId,
        definition: definitionRef(AGENT_BASE),
        input: { objective: "Internal routing" },
        wait: "await",
      }),
    /internal to the Phenix runtime/,
  );

  const internal = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "Internal routing" },
    wait: "await",
  });

  await assert.rejects(() => modelExecution.inspect(internal.id), /internal to the Phenix runtime/);
  assert.throws(
    () => modelExecution.cancel(internal.id, "operator request"),
    /internal to the Phenix runtime/,
  );

  await runtime.controller.fail(internal.id, {
    code: "provider_failed",
    message: "Router failed",
    retryable: true,
  });
  assert.throws(
    () => modelExecution.retry(runtime.rootRunId, internal.id),
    /internal to the Phenix runtime/,
  );
});
