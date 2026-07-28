import assert from "node:assert/strict";
import test from "node:test";

import { WORKFLOW_IMPLEMENT } from "../definitions/ids.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import { definitionRef, type WorkflowDefinition } from "../domain/definition/definition.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import type { RunRecord } from "../domain/run/model.ts";
import {
  latestCompatibleWorkflowCheckpoint,
  type WorkflowCheckpointSavedData,
} from "../domain/workflow/checkpoint.ts";
import {
  buildWorkflowGraphState,
  workflowCheckpointSnapshot,
} from "../domain/workflow/graph-state.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("live workflows persist one compatible replay checkpoint per state boundary", async () => {
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
    input: { objective: "Remain live while checkpointing" },
    wait: "await",
  });
  await runtime.store.events.drain();
  await runtime.checkpoints.checkpoint(handle.id);

  const run = runtime.store.projection.requireRun(handle.id);
  const events = runtime.store.projection.eventsFor(handle.id);
  const checkpoints = checkpointEvents(events);
  assert.equal(run.state, "waiting");
  assert.ok(checkpoints.length >= 1);

  const latest = checkpoints.at(-1);
  assert.ok(latest);
  const data = latest.data as WorkflowCheckpointSavedData;
  assert.deepEqual(Object.keys(data).sort(), [
    "definitionFingerprint",
    "definitionId",
    "snapshot",
    "snapshotFingerprint",
    "throughSequence",
  ]);
  assert.equal(data.definitionId, WORKFLOW_IMPLEMENT);
  assert.equal(data.definitionFingerprint.length, 64);
  assert.equal(data.snapshotFingerprint.length, 64);
  assert.ok(data.throughSequence < latest.sequence);

  const count = checkpoints.length;
  await runtime.checkpoints.checkpoint(handle.id);
  assert.equal(checkpointEvents(runtime.store.projection.eventsFor(handle.id)).length, count);

  await runtime.execution.cancel(handle.id, "checkpoint test complete");
  await runtime.checkpoints.shutdown();
});

test("checkpoint restoration equals full replay and ignores corrupt or incompatible snapshots", async () => {
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
    input: { objective: "Compare checkpoint replay" },
    wait: "await",
  });
  await runtime.store.events.drain();
  await runtime.checkpoints.checkpoint(handle.id);

  const run = runtime.store.projection.requireRun(handle.id);
  const definition = requireImplementationWorkflow();
  const events = runtime.store.projection.eventsFor(handle.id);
  const children = runtime.store.projection.childrenOf(handle.id);
  const restored = latestCompatibleWorkflowCheckpoint({ definition, events });
  assert.ok(restored);

  const checkpointState = buildWorkflowGraphState({ run, definition, events, children });
  const fullState = buildWorkflowGraphState({
    run,
    definition,
    events: events.filter((event) => event.type !== "workflow.checkpoint.saved"),
    children,
  });
  assert.deepEqual(
    workflowCheckpointSnapshot(checkpointState),
    workflowCheckpointSnapshot(fullState),
  );

  const validCheckpoint = checkpointEvents(events).at(-1);
  assert.ok(validCheckpoint);
  const corruptCheckpoint: DomainEvent = {
    ...validCheckpoint,
    eventId: "event-corrupt-checkpoint",
    sequence: validCheckpoint.sequence + 1,
    revision: validCheckpoint.revision + 1,
    data: {
      ...(validCheckpoint.data as WorkflowCheckpointSavedData),
      snapshotFingerprint: "0".repeat(64),
    },
  };
  const canonicalEvents = events.filter((event) => event.type !== "workflow.checkpoint.saved");
  assert.equal(
    latestCompatibleWorkflowCheckpoint({
      definition,
      events: [...canonicalEvents, corruptCheckpoint],
    }),
    undefined,
  );

  const changedDefinition: WorkflowDefinition<unknown, unknown> = {
    ...definition,
    limits: { ...definition.limits, timeoutMs: definition.limits.timeoutMs + 1 },
  };
  assert.equal(
    latestCompatibleWorkflowCheckpoint({ definition: changedDefinition, events }),
    undefined,
  );
  const fallbackState = buildWorkflowGraphState({
    run: run as RunRecord,
    definition: changedDefinition,
    events,
    children,
  });
  assert.deepEqual(
    workflowCheckpointSnapshot(fallbackState),
    workflowCheckpointSnapshot(fullState),
  );

  await runtime.execution.cancel(handle.id, "checkpoint test complete");
  await runtime.checkpoints.shutdown();
});

function checkpointEvents(events: readonly DomainEvent[]): readonly DomainEvent[] {
  return events.filter((event) => event.type === "workflow.checkpoint.saved");
}

function requireImplementationWorkflow(): WorkflowDefinition<unknown, unknown> {
  const definition = workflowDefinitions.find((candidate) => candidate.id === WORKFLOW_IMPLEMENT);
  assert.ok(definition);
  return definition;
}
