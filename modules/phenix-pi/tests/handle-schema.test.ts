import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeHandleRecord } from "../extensions/phenix-subagents/handle-store.ts";

function persistedHandle(): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    id: "schema-test",
    sessionId: "schema-session",
    modelSet: "mixed",
    assignment: {},
    producerSpec: {},
    producerCycles: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
  };
}

describe("persisted handle schema", () => {
  it("accepts the current backend-neutral shape", () => {
    assert.equal(decodeHandleRecord(persistedHandle()).id, "schema-test");
  });

  it("rejects malformed records", () => {
    assert.throws(() => decodeHandleRecord({ id: "incomplete" }), /malformed/);
  });
});
