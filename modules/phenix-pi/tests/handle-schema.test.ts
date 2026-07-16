import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PHENIX_API_VERSION } from "../extensions/phenix-kernel/api-version.ts";
import { decodeHandleRecord } from "../extensions/phenix-subagents/handle-store.ts";

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
  it("accepts only the current Phenix API version", () => {
    assert.equal(
      decodeHandleRecord(persistedHandle(PHENIX_API_VERSION)).version,
      PHENIX_API_VERSION,
    );
    assert.throws(
      () => decodeHandleRecord(persistedHandle(PHENIX_API_VERSION + 1)),
      /unsupported version/,
    );
  });
});
