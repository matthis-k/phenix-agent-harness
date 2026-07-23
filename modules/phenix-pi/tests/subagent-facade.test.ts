import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectHandleRecord } from "@matthis-k/phenix-suite/subagents/facade.ts";
import type { HandleRecord } from "@matthis-k/phenix-suite/subagents/handle-types.ts";

function record(overrides: Partial<HandleRecord>): HandleRecord {
  const timestamp = new Date().toISOString();
  return {
    id: "facade-test",
    sessionId: "session-test",
    modelSet: "mixed",
    assignment: {
      task: "Review the repository.",
      requirements: [],
      outputSchema: { type: "object" },
    },
    producerSpec: {
      role: null,
      agent: "phenix.base",
      model: "test-model",
      thinking: "medium",
      tier: "standard",
    } as HandleRecord["producerSpec"],
    producerCycles: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
    ...overrides,
  };
}

describe("subagent facade projection", () => {
  it("exposes a rejected output only as candidateValue", () => {
    const view = projectHandleRecord(
      record({
        status: "failed",
        candidateValue: { report: "unaccepted" },
        errors: ["critic rejected the result"],
      }),
    );

    assert.equal(view?.value, undefined);
    assert.deepEqual(view?.candidateValue, { report: "unaccepted" });
    assert.equal(view?.status, "failed");
  });

  it("exposes accepted output as value", () => {
    const view = projectHandleRecord(
      record({
        status: "completed",
        value: { report: "accepted" },
      }),
    );

    assert.deepEqual(view?.value, { report: "accepted" });
    assert.equal(view?.candidateValue, undefined);
  });
});
