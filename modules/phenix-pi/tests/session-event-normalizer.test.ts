import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isFailureEvent,
  providerFailureFromPiEvent,
} from "../packages/phenix-suite/runtime/session-event-normalizer.ts";

describe("session event provider failures", () => {
  it("recognizes an assistant message that settled with stopReason error", () => {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "400: upstream request failed",
      },
    };
    assert.equal(isFailureEvent(event), true);
    assert.deepEqual(providerFailureFromPiEvent(event), {
      code: "PROVIDER_FAILED",
      message: "400: upstream request failed",
    });
  });

  it("does not classify an ordinary settled message as a provider failure", () => {
    assert.equal(
      isFailureEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }),
      false,
    );
  });
});
