import assert from "node:assert/strict";
import test from "node:test";

import type { AttentionEnvelope, AttentionId, AttentionTarget } from "../domain/attention/model.ts";
import { AttentionProjection } from "../domain/attention/projection.ts";
import type {
  DomainEvent,
  DomainEventData,
  DomainEventType,
} from "../domain/run/events.ts";
import type { RunId } from "../domain/shared.ts";

const rootRunId = "root-attention" as RunId;
const targetRunId = "run-target" as RunId;
const attentionId = "attention-1" as AttentionId;
const target: AttentionTarget = {
  runId: targetRunId,
  delivery: "urgent",
  reason: "The target owns the affected work",
};
const envelope: AttentionEnvelope = {
  id: attentionId,
  rootRunId,
  source: { kind: "user" },
  message: "Revise the implementation boundary",
  receivedAt: "2026-07-24T12:00:00.000Z",
};

test("attention projection exposes deferred delivery and removes it after delivery", () => {
  const projection = new AttentionProjection();
  projection.apply(event("attention.received", { envelope }));
  projection.apply(
    event("attention.routed", {
      attentionId,
      routedBy: "model",
      targets: [target],
    }),
  );
  projection.apply(
    event("attention.delivery.deferred", {
      attentionId,
      target,
      reason: "Target is starting",
    }),
  );

  assert.deepEqual(projection.pendingDeliveries(rootRunId), [
    {
      attentionId,
      rootRunId,
      message: envelope.message,
      target,
    },
  ]);

  projection.apply(event("attention.delivered", { attentionId, target, deferred: true }));
  assert.deepEqual(projection.pendingDeliveries(rootRunId), []);
});

test("attention projection rejects delivery without a matching route", () => {
  const projection = new AttentionProjection();
  projection.apply(event("attention.received", { envelope }));

  assert.throws(
    () => projection.apply(event("attention.delivered", { attentionId, target, deferred: false })),
    /did not route/,
  );
});

test("attention projection rejects a second terminal delivery outcome", () => {
  const projection = new AttentionProjection();
  projection.apply(event("attention.received", { envelope }));
  projection.apply(
    event("attention.routed", {
      attentionId,
      routedBy: "explicit",
      targets: [target],
    }),
  );
  projection.apply(event("attention.delivered", { attentionId, target, deferred: false }));

  assert.throws(
    () =>
      projection.apply(
        event("attention.delivery.failed", {
          attentionId,
          target,
          reason: "late failure",
        }),
      ),
    /already terminal/,
  );
});

let sequence = 0;
type AttentionEventType = Extract<DomainEventType, `attention.${string}`>;

function event<const TType extends AttentionEventType>(
  type: TType,
  data: DomainEventData<TType>,
): DomainEvent<TType> {
  sequence += 1;
  return {
    eventId: `event-${sequence}`,
    rootRunId,
    runId: rootRunId,
    sequence,
    revision: sequence,
    timestamp: "2026-07-24T12:00:00.000Z",
    type,
    data,
  } as DomainEvent<TType>;
}
