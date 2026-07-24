import assert from "node:assert/strict";
import test from "node:test";

import type {
  RunController,
  RunImplementation,
  StartImplementationCommand,
} from "../application/execution-facade.ts";
import { SupervisionProcessManager } from "../application/supervision-process-manager.ts";
import { AGENT_COORDINATOR, AGENT_SCOUT } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { RunId } from "../domain/shared.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

class RecordingPendingAgent implements RunImplementation {
  private controller?: RunController;
  readonly messages: {
    readonly runId: RunId;
    readonly message: string;
    readonly delivery: "normal" | "nextTurn";
  }[] = [];

  bind(controller: RunController): void {
    this.controller = controller;
  }

  async start(command: StartImplementationCommand): Promise<void> {
    if (!this.controller) throw new Error("Recording agent is not bound");
    await this.controller.transition(command.runId, "starting");
    await this.controller.transition(command.runId, "running");
  }

  async send(
    runId: RunId,
    message: string,
    delivery: "normal" | "nextTurn",
  ): Promise<void> {
    this.messages.push({ runId, message, delivery });
  }
}

test("supervision process reports descendant failure and notifies its active parent", async () => {
  const implementation = new RecordingPendingAgent();
  const runtime = await createTestRuntime(implementation, {
    rootInvokableDefinitions: [AGENT_COORDINATOR],
  });
  implementation.bind(runtime.controller);

  const rootNotices: string[] = [];
  const supervision = new SupervisionProcessManager({
    execution: runtime.execution,
    store: runtime.store,
    notifyRoot: (message) => {
      rootNotices.push(message);
    },
  });

  const parent = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(AGENT_COORDINATOR),
    input: { objective: "Coordinate a focused repository review" },
    wait: "await",
  });
  const child = await runtime.execution.start({
    parentId: parent.id,
    definition: definitionRef(AGENT_SCOUT),
    input: { objective: "Inspect the execution boundary" },
    wait: "await",
  });

  await runtime.controller.fail(child.id, {
    code: "provider_failed",
    message: "Required evidence is unavailable",
    retryable: true,
  });
  await runtime.store.events.drain();

  assert.equal(rootNotices.length, 1);
  assert.match(rootNotices[0] ?? "", /Required evidence is unavailable/);
  assert.deepEqual(
    implementation.messages.map(({ runId, delivery }) => ({ runId, delivery })),
    [{ runId: parent.id, delivery: "nextTurn" }],
  );
  assert.match(implementation.messages[0]?.message ?? "", /Inspect the failure report/);

  supervision.shutdown();
});
