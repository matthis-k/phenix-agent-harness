import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ChildRunId } from "../extensions/phenix-runtime/child-session-types.ts";
import { ManagedSubagentRegistry } from "../extensions/phenix-runtime/managed-subagent-registry.ts";
import type {
  SubagentCancellation,
  SubagentEvent,
  SubagentHandle,
  SubagentSnapshot,
} from "../extensions/phenix-runtime/subagent-manager.ts";
import { SubagentExecutionError } from "../extensions/phenix-runtime/subagent-manager.ts";
import { readRecord, writeRecord } from "../extensions/phenix-subagents/handle-store.ts";
import type { HandleRecord } from "../extensions/phenix-subagents/handle-types.ts";
import { ManagedDelegationRuntime } from "../extensions/phenix-subagents/managed-delegation-runtime.ts";

function temporaryDirectory(prefix: string): string {
  const directory = path.join(os.tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function runningRecord(childRunId: ChildRunId): HandleRecord {
  const timestamp = new Date().toISOString();
  return {
    version: 4,
    id: "managed-await",
    sessionId: "managed-session",
    modelSet: "mixed",
    assignment: {
      task: "Exercise background await semantics.",
      requirements: [],
      outputSchema: { type: "object" },
    },
    producerSpec: {} as HandleRecord["producerSpec"],
    childRunId,
    rootChildRunId: childRunId,
    producerCycles: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
  };
}

class RejectingHandle implements SubagentHandle<unknown> {
  readonly id: string;
  private readonly failure: SubagentExecutionError;

  constructor(id: string, failure: SubagentExecutionError) {
    this.id = id;
    this.failure = failure;
  }

  snapshot(): SubagentSnapshot {
    return { id: this.id, status: "running" };
  }

  poll(): Promise<SubagentSnapshot> {
    return Promise.resolve(this.snapshot());
  }

  result(signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new SubagentExecutionError("ABORTED", "The wait was cancelled."));
    }
    return Promise.reject(this.failure);
  }

  send(_message: string, _signal?: AbortSignal): Promise<void> {
    return Promise.resolve();
  }

  cancel(_cancellation?: string | SubagentCancellation): Promise<void> {
    return Promise.resolve();
  }

  subscribe(_listener: (event: SubagentEvent) => void): () => void {
    return () => {};
  }
}

function runtimeWith(handle: SubagentHandle<unknown>): ManagedDelegationRuntime {
  const registry = new ManagedSubagentRegistry();
  registry.add(handle);
  return new ManagedDelegationRuntime({ managers: {} as never, registry });
}

describe("ManagedDelegationRuntime background awaits", () => {
  it("returns the persisted failed handle after child failure", async () => {
    const cwd = temporaryDirectory("phenix-managed-await-failure");
    const childRunId = "managed-failure" as ChildRunId;
    const record = runningRecord(childRunId);
    writeRecord(cwd, record);
    const runtime = runtimeWith(
      new RejectingHandle(
        childRunId,
        new SubagentExecutionError("PROVIDER_FAILED", "execution failed"),
      ),
    );

    const settled = await runtime.awaitHandle(
      { cwd, sessionId: record.sessionId, id: record.id },
      new AbortController().signal,
    );

    assert.equal(settled?.status, "failed");
    assert.deepEqual(settled?.errors, ["PROVIDER_FAILED: execution failed"]);
    assert.equal(readRecord(cwd, record.sessionId, record.id)?.status, "failed");
  });

  it("throws for a cancelled wait and leaves the persisted child running", async () => {
    const cwd = temporaryDirectory("phenix-managed-await-cancelled");
    const childRunId = "managed-wait-cancelled" as ChildRunId;
    const record = runningRecord(childRunId);
    writeRecord(cwd, record);
    const runtime = runtimeWith(
      new RejectingHandle(
        childRunId,
        new SubagentExecutionError("PROVIDER_FAILED", "execution failed"),
      ),
    );
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      runtime.awaitHandle({ cwd, sessionId: record.sessionId, id: record.id }, controller.signal),
      (error: unknown) => error instanceof SubagentExecutionError && error.code === "ABORTED",
    );

    assert.equal(readRecord(cwd, record.sessionId, record.id)?.status, "running");
  });
});
