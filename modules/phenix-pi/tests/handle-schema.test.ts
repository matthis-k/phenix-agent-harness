import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeHandleRecord } from "../extensions/phenix-subagents/handle-store.ts";
import { HANDLE_VERSION } from "../extensions/phenix-subagents/handle-types.ts";

function persistedHandle(version: number): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    version,
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
  it("accepts the current backend-neutral schema", () => {
    assert.equal(HANDLE_VERSION, 5);
    assert.equal(decodeHandleRecord(persistedHandle(5)).version, 5);
  });

  it("rejects obsolete persisted handle versions", () => {
    assert.throws(() => decodeHandleRecord(persistedHandle(4)), /unsupported version/);
  });
});
