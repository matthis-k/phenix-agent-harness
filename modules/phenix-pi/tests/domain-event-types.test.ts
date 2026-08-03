import assert from "node:assert/strict";
import test from "node:test";

import type { PendingDomainEvent } from "../domain/run/events.ts";
import { failed, runId, success } from "../domain/shared.ts";

const RUN_ID = runId("run-event-type-test");

test("domain events preserve their discriminator-specific payload", () => {
  const event: PendingDomainEvent<"run.completed"> = {
    runId: RUN_ID,
    type: "run.completed",
    data: { outcome: success({ accepted: true }) },
  };

  assert.equal(event.data.outcome.status, "success");
  assert.deepEqual(event.data.outcome.value, { accepted: true });
});

const invalidCompletedEvent: PendingDomainEvent<"run.completed"> = {
  runId: RUN_ID,
  type: "run.completed",
  data: {
    // @ts-expect-error A failed outcome cannot be paired with run.completed.
    outcome: failed({ code: "provider_failed", message: "lost", retryable: true }),
  },
};

const invalidToolEvent: PendingDomainEvent<"run.tool.started"> = {
  runId: RUN_ID,
  type: "run.tool.started",
  // @ts-expect-error The discriminator determines the exact payload fields.
  data: { number: 1 },
};

void invalidCompletedEvent;
void invalidToolEvent;
