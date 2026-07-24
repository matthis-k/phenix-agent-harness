import assert from "node:assert/strict";
import test from "node:test";

import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import { runId } from "../domain/shared.ts";

test("subscriber failures are reported through the injected host boundary", async () => {
  const failures: unknown[] = [];
  const bus = new OrderedDomainEventBus({
    onSubscriberError: (failure) => {
      failures.push(failure);
    },
  });
  bus.subscribe(() => {
    throw new Error("subscriber failed");
  });
  const event = {
    sequence: 1,
    rootRunId: runId("root-test"),
    runId: runId("root-test"),
    type: "run.input.amended",
    timestamp: "2026-07-24T00:00:00.000Z",
    data: { text: "test" },
  } as DomainEvent;

  bus.publish([event]);
  await bus.drain();

  assert.equal(failures.length, 1);
  assert.equal((failures[0] as { event: DomainEvent }).event, event);
});
