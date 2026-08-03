import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { assistantFailureObservation } from "../adapters/pi-sdk/assistant-stop-reason.ts";

function message(value: Readonly<Record<string, unknown>>): AgentMessage {
  return value as unknown as AgentMessage;
}

test("treats an unexplained aborted assistant turn as a retryable backend failure", () => {
  assert.deepEqual(
    assistantFailureObservation(message({ role: "assistant", stopReason: "aborted" })),
    {
      type: "backend.failed",
      message: "Pi assistant turn ended with stopReason=aborted",
      retryable: true,
    },
  );
});

test("preserves provider error details", () => {
  assert.deepEqual(
    assistantFailureObservation(
      message({ role: "assistant", stopReason: "error", errorMessage: "connection reset" }),
    ),
    {
      type: "backend.failed",
      message: "connection reset",
      retryable: true,
    },
  );
});

test("does not classify normal assistant completion as a failure", () => {
  assert.equal(
    assistantFailureObservation(message({ role: "assistant", stopReason: "stop" })),
    undefined,
  );
  assert.equal(assistantFailureObservation(message({ role: "user" })), undefined);
});
