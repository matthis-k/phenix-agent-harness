import assert from "node:assert/strict";
import test from "node:test";

import { parsePersistedDomainEvent } from "../domain/run/event-codec.ts";
import { runId } from "../domain/shared.ts";

const ROOT = runId("root-event-codec");

function validEvent(): Readonly<Record<string, unknown>> {
  return {
    eventId: "event-1",
    rootRunId: ROOT,
    runId: ROOT,
    sequence: 1,
    revision: 1,
    timestamp: "2026-08-03T00:00:00.000Z",
    type: "run.turn.ended",
    data: {},
  };
}

test("decodes a known persisted event envelope", () => {
  assert.deepEqual(parsePersistedDomainEvent(validEvent()), validEvent());
});

test("rejects unknown event discriminators before entering the domain", () => {
  assert.throws(
    () => parsePersistedDomainEvent({ ...validEvent(), type: "run.future.event" }),
    /Unsupported domain event type/,
  );
});

test("rejects malformed event identity and sequencing metadata", () => {
  assert.throws(
    () => parsePersistedDomainEvent({ ...validEvent(), runId: "bad run id" }),
    /run ID contains unsupported characters/,
  );
  assert.throws(
    () => parsePersistedDomainEvent({ ...validEvent(), sequence: 0 }),
    /sequence must be a positive integer/,
  );
});

test("requires event payloads to remain object-shaped", () => {
  assert.throws(
    () => parsePersistedDomainEvent({ ...validEvent(), data: null }),
    /run.turn.ended data must be an object/,
  );
});
