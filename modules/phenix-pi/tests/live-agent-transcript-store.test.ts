import assert from "node:assert/strict";
import test from "node:test";

import { LiveAgentTranscriptStore } from "../adapters/pi-sdk/live-agent-transcript-store.ts";
import { runId } from "../domain/shared.ts";

const RUN_ID = runId("run-live-transcript-store");

test("complete live transcripts may exist before a session file is available", () => {
  const store = new LiveAgentTranscriptStore();

  store.open(RUN_ID, { sessionId: "session-live" }, true);

  assert.deepEqual(store.get(RUN_ID), {
    runId: RUN_ID,
    sessionId: "session-live",
    completeHistory: true,
    messages: [],
  });
});

test("partial live transcripts retain their required durable source", () => {
  const store = new LiveAgentTranscriptStore();

  store.open(RUN_ID, { sessionId: "session-live", sessionFile: "/tmp/session-live.jsonl" }, false);

  assert.deepEqual(store.get(RUN_ID), {
    runId: RUN_ID,
    sessionId: "session-live",
    sessionFile: "/tmp/session-live.jsonl",
    completeHistory: false,
    messages: [],
  });
});

test("rejects partial transcript state without a durable source", () => {
  const store = new LiveAgentTranscriptStore();

  assert.throws(
    () => store.open(RUN_ID, { sessionId: "session-live" }, false),
    /requires a durable Pi session file/,
  );
  assert.equal(store.get(RUN_ID), undefined);
});
