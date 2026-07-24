import assert from "node:assert/strict";
import test from "node:test";

import { BoundedAgentSessionPort } from "../adapters/pi-sdk/bounded-agent-session-port.ts";
import type {
  AgentSessionObservation,
  AgentSessionPort,
  AgentSessionReference,
} from "../ports/agent-session-backend.ts";

class HangingSession implements AgentSessionPort {
  readonly reference: AgentSessionReference = { sessionId: "hanging" };
  readonly isStreaming = false;
  abortCalls = 0;
  disposeCalls = 0;

  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async notify(): Promise<void> {}

  abort(): Promise<void> {
    this.abortCalls += 1;
    return new Promise(() => undefined);
  }

  dispose(): Promise<void> {
    this.disposeCalls += 1;
    return new Promise(() => undefined);
  }

  subscribe(_listener: (event: AgentSessionObservation) => void): () => void {
    return () => undefined;
  }
}

test("Pi session abort and disposal cannot block run termination indefinitely", async () => {
  const inner = new HangingSession();
  const session = new BoundedAgentSessionPort(inner, 5);

  await assert.rejects(session.abort(), /Pi session abort timed out after 5ms/);
  await assert.rejects(session.dispose(), /Pi session disposal timed out after 5ms/);
  assert.equal(inner.abortCalls, 1);
  assert.equal(inner.disposeCalls, 1);
});
