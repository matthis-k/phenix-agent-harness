import assert from "node:assert/strict";
import "./support/default-workflow-fixture.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

import {
  abandonWorkflowRecord,
  acceptTransition,
  acquireWorkflowLock,
  beginTransition,
  createWorkflowRecord,
  readWorkflowRecord,
  rejectTransition,
  releaseWorkflowLock,
  verifyWorkflowActorExists,
  WorkflowStoreError,
} from "@matthis-k/phenix-flow/workflow-store.ts";
import type { WorkflowRuntimeRecord } from "@matthis-k/phenix-flow/workflow-types.ts";
import { mkTransitionId } from "@matthis-k/phenix-flow/workflow-types.ts";

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

function requireRecord(value: WorkflowRuntimeRecord | undefined): WorkflowRuntimeRecord {
  assert.ok(value);
  return value;
}

function isStoreError(code: WorkflowStoreError["code"]) {
  return (error: unknown): boolean => error instanceof WorkflowStoreError && error.code === code;
}

describe("Workflow Store", () => {
  let directory: string;

  beforeEach(() => {
    directory = path.join(os.tmpdir(), `phenix-test-store-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(directory, { recursive: true });
  });

  it("creates and reads a workflow record", () => {
    const params = makeRecordParams();
    const record = createWorkflowRecord(directory, params);

    assert.equal(record.instanceId, params.instanceId);
    assert.equal(record.state, "classified");
    assert.equal(record.revision, 0);

    const read = requireRecord(readWorkflowRecord(directory, params.instanceId, params.actorId));
    assert.equal(read.state, "classified");
  });

  it("beginTransition advances revision and adds active entry", () => {
    const params = makeRecordParams();
    const record = createWorkflowRecord(directory, params);

    const result = beginTransition(directory, record, {
      expectedRevision: 0,
      transitionId: mkTransitionId("delegate_to_scout"),
      handleId: "handle-1",
    });

    assert.ok(result.executionId.startsWith("wfexec_"));
    assert.equal(result.record.active.length, 1);

    const reread = requireRecord(readWorkflowRecord(directory, params.instanceId, params.actorId));
    assert.equal(reread.active.length, 1);
    assert.equal(reread.revision, 1);
  });

  it("throws STALE_REVISION when expected revision is wrong", () => {
    const params = makeRecordParams();
    const record = createWorkflowRecord(directory, params);

    beginTransition(directory, record, {
      expectedRevision: 0,
      transitionId: mkTransitionId("delegate_to_scout"),
      handleId: "handle-1",
    });

    assert.throws(
      () =>
        beginTransition(directory, record, {
          expectedRevision: 0,
          transitionId: mkTransitionId("delegate_to_planner"),
          handleId: "handle-2",
        }),
      isStoreError("STALE_REVISION"),
    );
  });

  it("acceptTransition advances state and marks completed", () => {
    const params = makeRecordParams();
    let record = createWorkflowRecord(directory, params);

    const { executionId } = beginTransition(directory, record, {
      expectedRevision: 0,
      transitionId: mkTransitionId("delegate_to_scout"),
      handleId: "handle-1",
    });

    record = requireRecord(readWorkflowRecord(directory, params.instanceId, params.actorId));

    const updated = acceptTransition(directory, record, {
      executionId,
      nextState: "scouting",
    });

    assert.equal(updated.state, "scouting");
    assert.equal(updated.active.length, 0);
    assert.equal(updated.completed.length, 1);
    assert.ok(updated.completed[0]?.accepted);
  });

  it("rejectTransition advances state and marks rejected", () => {
    const params = makeRecordParams();
    let record = createWorkflowRecord(directory, params);

    const { executionId } = beginTransition(directory, record, {
      expectedRevision: 0,
      transitionId: mkTransitionId("delegate_to_scout"),
      handleId: "handle-1",
    });

    record = requireRecord(readWorkflowRecord(directory, params.instanceId, params.actorId));

    const updated = rejectTransition(directory, record, {
      executionId,
      nextState: "classified",
    });

    assert.equal(updated.state, "classified");
    assert.equal(updated.completed.length, 1);
    assert.equal(updated.completed[0]?.accepted, false);
  });

  it("accept/reject are idempotent for unknown executionId", () => {
    const params = makeRecordParams();
    const record = createWorkflowRecord(directory, params);

    const updated = acceptTransition(directory, record, {
      executionId: "wfexec_nonexistent",
      nextState: "scouting",
    });

    assert.equal(updated.state, record.state);
    assert.equal(updated.revision, record.revision);
    assert.equal(updated.instanceId, record.instanceId);
    assert.equal(updated.actorId, record.actorId);
  });

  it("abandons an active workflow as a terminal session-release state", () => {
    const params = makeRecordParams();
    const record = createWorkflowRecord(directory, params);
    beginTransition(directory, record, {
      expectedRevision: 0,
      transitionId: mkTransitionId("delegate_to_scout"),
      handleId: "handle-abandon",
    });

    const active = requireRecord(readWorkflowRecord(directory, params.instanceId, params.actorId));
    const abandoned = abandonWorkflowRecord(directory, active, "user discarded workflow");

    assert.equal(abandoned.state, "abandoned");
    assert.equal(abandoned.active.length, 0);
    assert.equal(abandoned.facts.abandonedReason, "user discarded workflow");
    assert.equal(abandoned.revision, active.revision + 1);
  });

  it("verifyWorkflowActorExists throws for missing record", () => {
    assert.throws(
      () => verifyWorkflowActorExists(directory, "nonexistent", "fake"),
      isStoreError("CHILD_ACTOR_MISSING"),
    );
  });

  it("verifyWorkflowActorExists succeeds for existing record", () => {
    const params = makeRecordParams();
    createWorkflowRecord(directory, params);

    assert.doesNotThrow(() =>
      verifyWorkflowActorExists(directory, params.instanceId, params.actorId),
    );
  });
});

describe("Workflow Store — Concurrency", () => {
  let directory: string;

  beforeEach(() => {
    directory = path.join(os.tmpdir(), `phenix-test-lock-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(directory, { recursive: true });
  });

  it("acquires and releases lock", () => {
    const params = makeRecordParams();
    createWorkflowRecord(directory, params);

    const lock = acquireWorkflowLock(directory, params.instanceId, params.actorId);
    assert.ok(lock.lockPath.endsWith(".lock"));

    releaseWorkflowLock(lock);

    const nextLock = acquireWorkflowLock(directory, params.instanceId, params.actorId);
    releaseWorkflowLock(nextLock);
  });

  it("lock is exclusive — second acquire fails with LOCK_CONTENTION", () => {
    const params = makeRecordParams();
    createWorkflowRecord(directory, params);

    const lock = acquireWorkflowLock(directory, params.instanceId, params.actorId);

    assert.throws(
      () => acquireWorkflowLock(directory, params.instanceId, params.actorId, 100),
      isStoreError("LOCK_CONTENTION"),
    );

    releaseWorkflowLock(lock);
  });

  it("releasing and re-acquiring works", () => {
    const params = makeRecordParams();
    createWorkflowRecord(directory, params);

    const lock = acquireWorkflowLock(directory, params.instanceId, params.actorId);
    releaseWorkflowLock(lock);

    assert.doesNotThrow(() => {
      const nextLock = acquireWorkflowLock(directory, params.instanceId, params.actorId, 1000);
      releaseWorkflowLock(nextLock);
    });
  });

  it("different actors can hold locks simultaneously", () => {
    const first = makeRecordParams();
    const second = makeRecordParams();
    createWorkflowRecord(directory, first);
    createWorkflowRecord(directory, second);

    const firstLock = acquireWorkflowLock(directory, first.instanceId, first.actorId);
    const secondLock = acquireWorkflowLock(directory, second.instanceId, second.actorId);

    releaseWorkflowLock(firstLock);
    releaseWorkflowLock(secondLock);
  });
});
