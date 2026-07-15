import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChildSessionBackend } from "../extensions/phenix-runtime/child-session-types.ts";
import type { HandleRecord } from "../extensions/phenix-subagents/handle-types.ts";
import { ExecutionQualityService } from "../extensions/phenix-subagents/execution-quality-service.ts";

const backend = { kind: "sdk" } as ChildSessionBackend;
const modelRegistry = { find: () => undefined } as never;

function service(): ExecutionQualityService {
  return new ExecutionQualityService({
    backend,
    resolveModelRegistry: () => modelRegistry,
  });
}

describe("ExecutionQualityService", () => {
  it("accepts producer output when no verification command fails", async () => {
    const record = {
      producerSpec: {
        verificationCommands: [],
      },
    } as unknown as HandleRecord;

    const result = await service().verify({
      record,
      value: { ok: true },
      cwd: "/tmp",
      signal: new AbortController().signal,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.summary.acceptanceStatus, "verified");
    assert.deepEqual(result.summary.verifyRuns, []);
  });

  it("fails explicitly when a required critic specification is absent", async () => {
    const record = {
      id: "quality-test",
      criticSpec: undefined,
    } as unknown as HandleRecord;

    await assert.rejects(
      service().review({
        record,
        producerValue: {},
        verification: {
          acceptanceStatus: "verified",
          runtimeChecks: [],
          verifyRuns: [],
          reviewFindings: [],
          contract: "valid",
        },
        cwd: "/tmp",
        signal: new AbortController().signal,
      }),
      /Required critic specification is missing/,
    );
  });
});
