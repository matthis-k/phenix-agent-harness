import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  acquireWorkflowLock,
  releaseWorkflowLock,
  createWorkflowRecord,
  readWorkflowRecord,
  beginTransition,
  acceptTransition,
  rejectTransition,
  writeWorkflowRecord,
  verifyWorkflowActorExists,
  WorkflowStoreError,
  type LockHandle,
} from "../extensions/phenix-workflow/workflow-store.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function setup() {
  tmpDir = path.join(os.tmpdir(), `phenix-test-store-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
}

function teardown() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
}

function makeRecordParams(overrides?: Record<string, unknown>) {
  return {
    instanceId: `inst-${randomUUID().slice(0, 6)}`,
    actorId: `actor-${randomUUID().slice(0, 6)}`,
    sessionId: "test-session",
    definitionId: "phenix-default" as const,
    difficulty: "D2" as const,
    taskProfile: {
      complexity: 2,
      uncertainty: 1,
      consequence: 2,
      breadth: 2,
      coupling: 1,
      novelty: 1,
    },
    actorRole: "coordinator" as const,
    capabilityArtifactHash: "0".repeat(64),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Workflow Store", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `phenix-test-store-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
  });

  it("creates and reads a workflow record", () => {
    const params = makeRecordParams();
    const record = createWorkflowRecord(dir, params);

    assert.equal(record.instanceId, params.instanceId);
    assert.equal(record.state, "classified");
    assert.equal(record.revision, 0);

    const read = readWorkflowRecord(dir, params.instanceId, params.actorId);
    assert.ok(read);
    assert.equal(read?.state, "classified");
  });

  it("beginTransition advances revision and adds active entry", () => {
    const params = makeRecordParams();
    let record = createWorkflowRecord(dir, params);

    const result = beginTransition(dir, record, {
      expectedRevision: 0,
      transitionId: "delegate_to_scout" as any,
      handleId: "handle-1",
    });

    assert.ok(result.executionId.startsWith("wfexec_"));
    assert.equal(result.record.active.length, 1);

    // Re-read to verify persistence.
    const reread = readWorkflowRecord(dir, params.instanceId, params.actorId);
    assert.ok(reread);
    assert.equal(reread?.active.length, 1);
    assert.equal(reread?.revision, 1);
  });

  it("throws STALE_REVISION when expected revision is wrong", () => {
    const params = makeRecordParams();
    let record = createWorkflowRecord(dir, params);

    // Make first transition.
    beginTransition(dir, record, {
      expectedRevision: 0,
      transitionId: "delegate_to_scout" as any,
      handleId: "handle-1",
    });

    // Retry with stale expectedRevision.
    assert.throws(
      () => beginTransition(dir, record, {
        expectedRevision: 0,
        transitionId: "delegate_to_planner" as any,
        handleId: "handle-2",
      }),
      (err: any) => err instanceof WorkflowStoreError && err.code === "STALE_REVISION",
    );
  });

  it("acceptTransition advances state and marks completed", () => {
    const params = makeRecordParams();
    let record = createWorkflowRecord(dir, params);

    const { executionId } = beginTransition(dir, record, {
      expectedRevision: 0,
      transitionId: "delegate_to_scout" as any,
      handleId: "handle-1",
    });

    // Re-read to get updated revision.
    record = readWorkflowRecord(dir, params.instanceId, params.actorId)!;

    const updated = acceptTransition(dir, record, {
      executionId,
      nextState: "scouting",
    });

    assert.equal(updated.state, "scouting");
    assert.equal(updated.active.length, 0);
    assert.equal(updated.completed.length, 1);
    assert.ok(updated.completed[0].accepted);
  });

  it("rejectTransition advances state and marks rejected", () => {
    const params = makeRecordParams();
    let record = createWorkflowRecord(dir, params);

    const { executionId } = beginTransition(dir, record, {
      expectedRevision: 0,
      transitionId: "delegate_to_scout" as any,
      handleId: "handle-1",
    });

    record = readWorkflowRecord(dir, params.instanceId, params.actorId)!;

    const updated = rejectTransition(dir, record, {
      executionId,
      nextState: "classified",
    });

    assert.equal(updated.state, "classified");
    assert.equal(updated.completed.length, 1);
    assert.ok(!updated.completed[0].accepted);
  });

  it("accept/reject are idempotent for unknown executionId", () => {
    const params = makeRecordParams();
    let record = createWorkflowRecord(dir, params);

    const updated = acceptTransition(dir, record, {
      executionId: "wfexec_nonexistent",
      nextState: "scouting",
    });

    // Should return same record unchanged.
    assert.equal(updated, record);
  });

  it("verifyWorkflowActorExists throws for missing record", () => {
    assert.throws(
      () => verifyWorkflowActorExists(dir, "nonexistent", "fake"),
      (err: any) => err instanceof WorkflowStoreError && err.code === "CHILD_ACTOR_MISSING",
    );
  });

  it("verifyWorkflowActorExists succeeds for existing record", () => {
    const params = makeRecordParams();
    createWorkflowRecord(dir, params);

    assert.doesNotThrow(
      () => verifyWorkflowActorExists(dir, params.instanceId, params.actorId),
    );
  });
});

describe("Workflow Store — Concurrency", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `phenix-test-lock-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
  });

  it("acquires and releases lock", () => {
    const params = makeRecordParams();
    createWorkflowRecord(dir, params);

    const lock = acquireWorkflowLock(dir, params.instanceId, params.actorId);
    assert.ok(lock.lockPath.endsWith(".lock"));

    releaseWorkflowLock(lock);

    // Should be able to re-acquire after release.
    const lock2 = acquireWorkflowLock(dir, params.instanceId, params.actorId);
    releaseWorkflowLock(lock2);
  });

  it("lock is exclusive — second acquire fails with LOCK_CONTENTION", () => {
    const params = makeRecordParams();
    createWorkflowRecord(dir, params);

    const lock1 = acquireWorkflowLock(dir, params.instanceId, params.actorId);

    assert.throws(
      () => acquireWorkflowLock(dir, params.instanceId, params.actorId, 100),
      (err: any) => err instanceof WorkflowStoreError && err.code === "LOCK_CONTENTION",
    );

    releaseWorkflowLock(lock1);
  });

  it("releasing and re-acquiring works", () => {
    const params = makeRecordParams();
    createWorkflowRecord(dir, params);

    const lock = acquireWorkflowLock(dir, params.instanceId, params.actorId);
    releaseWorkflowLock(lock);

    // Re-acquire should succeed.
    assert.doesNotThrow(() => {
      const lock2 = acquireWorkflowLock(dir, params.instanceId, params.actorId, 1000);
      releaseWorkflowLock(lock2);
    });
  });

  it("different actors can hold locks simultaneously", () => {
    const params1 = makeRecordParams();
    const params2 = makeRecordParams();
    createWorkflowRecord(dir, params1);
    createWorkflowRecord(dir, params2);

    // Different actors should not conflict.
    const lock1 = acquireWorkflowLock(dir, params1.instanceId, params1.actorId);
    const lock2 = acquireWorkflowLock(dir, params2.instanceId, params2.actorId);

    releaseWorkflowLock(lock1);
    releaseWorkflowLock(lock2);
  });
});
