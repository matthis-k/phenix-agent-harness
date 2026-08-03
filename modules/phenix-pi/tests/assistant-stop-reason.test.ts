import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { assistantFailureObservation } from "../adapters/pi-sdk/assistant-stop-reason.ts";

function message(value: Readonly<Record<string, unknown>>): AgentMessage {
  return value as unknown as AgentMessage;
}

test("classifies an unexplained aborted assistant turn as an unexpected abort", () => {
  assert.deepEqual(
    assistantFailureObservation(message({ role: "assistant", stopReason: "aborted" })),
    {
      type: "backend.failed",
      kind: "unexpected_abort",
      stopReason: "aborted",
      message: "Pi assistant turn ended with stopReason=aborted",
      retryable: true,
    },
  );
});

test("classifies provider errors without losing the provider message", () => {
  assert.deepEqual(
    assistantFailureObservation(
      message({ role: "assistant", stopReason: "error", errorMessage: "connection reset" }),
    ),
    {
      type: "backend.failed",
      kind: "provider_error",
      stopReason: "error",
      message: "connection reset",
      retryable: true,
      providerMessage: "connection reset",
    },
  );
});

test("represents a provider error without a provider message explicitly", () => {
  assert.deepEqual(
    assistantFailureObservation(message({ role: "assistant", stopReason: "error" })),
    {
      type: "backend.failed",
      kind: "provider_error",
      stopReason: "error",
      message: "Pi provider failed",
      retryable: true,
      providerMessage: null,
    },
  );
});

test("does not classify successful assistant stop reasons as failures", () => {
  for (const stopReason of ["stop", "length", "toolUse"] as const) {
    assert.equal(
      assistantFailureObservation(message({ role: "assistant", stopReason })),
      undefined,
    );
  }
  assert.equal(assistantFailureObservation(message({ role: "user" })), undefined);
});
