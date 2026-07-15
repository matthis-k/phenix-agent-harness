import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  type ChildRun,
  ChildRuntimeError,
  type ContractSubmissionChannel,
  childRunId,
} from "../extensions/phenix-runtime/child-session-types.ts";
import { executeProducerCycles } from "../extensions/phenix-subagents/attempt-runner.ts";
import type { HandleRecord } from "../extensions/phenix-subagents/handle-types.ts";
import { isTerminalHandleStatus } from "../extensions/phenix-subagents/handle-types.ts";
import {
  finalizeHandleWorkflow,
  initialWorkflowStateForRole,
} from "../extensions/phenix-workflow/workflow-runtime.ts";
import {
  beginTransition,
  createWorkflowRecord,
  readWorkflowRecord,
} from "../extensions/phenix-workflow/workflow-store.ts";

function temporaryDirectory(prefix: string): string {
  const directory = path.join(os.tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function makeHandle(): HandleRecord {
  const timestamp = new Date().toISOString();
  return {
    version: 5,
    id: "handle-timeout",
    sessionId: "session-timeout",
    modelSet: "test",
    assignment: {
      task: "test timeout ownership",
      requirements: [],
      outputSchema: { type: "object" },
    },
    producerSpec: { criticRequired: false } as HandleRecord["producerSpec"],
    producerCycles: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
  };
}

describe("runtime cancellation ownership", () => {
  it("preserves TIMEOUT after verification and does not start repair", async () => {
    const cwd = temporaryDirectory("phenix-attempt-timeout");
    const controller = new AbortController();
    const record = makeHandle();
    let continued = false;
    let reopened = false;
    let accepted = false;

    const run: ChildRun = {
      id: childRunId("child-timeout"),
      backend: "sdk",
      pi: { sessionId: "pi-timeout" },
      snapshot: () => ({}) as ReturnType<ChildRun["snapshot"]>,
      subscribe: () => () => undefined,
      continue: async () => {
        continued = true;
        return { cycle: 2, status: "settled" };
      },
      waitForCurrentCycle: async () => ({ cycle: 1, status: "settled" }),
      abort: async () => undefined,
      dispose: async () => undefined,
    };

    const channel: ContractSubmissionChannel = {
      current: () => ({
        contractId: "contract-timeout",
        state: "submitted",
        revision: 1,
        outputSchema: { type: "object" },
      }),
      submit: async () => ({ ok: true, state: "submitted", revision: 1 }),
      reopen: async () => {
        reopened = true;
      },
      accept: async () => {
        accepted = true;
      },
      cancel: async () => undefined,
      readSubmitted: async () => ({ value: { done: true }, revision: 1 }),
    };

    const result = await executeProducerCycles({
      run,
      contractChannel: channel,
      contractArtifact: {
        assignment: { outputSchema: { type: "object" } },
      } as never,
      record,
      cwd,
      signal: controller.signal,
      maximumProducerCycles: 2,
      completionGraceRemaining: 0,
      verify: async () => {
        controller.abort(new ChildRuntimeError("TIMEOUT", "verification deadline exceeded"));
        return {
          ok: false,
          issues: [{ path: ["verification"], message: "cancelled" }],
          summary: {
            acceptanceStatus: "rejected",
            runtimeChecks: [],
            verifyRuns: ["cancelled"],
            reviewFindings: [],
            contract: "cancelled",
          },
        };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "TIMEOUT");
    assert.equal(record.status, "failed");
    assert.equal(continued, false);
    assert.equal(reopened, false);
    assert.equal(accepted, false);
  });
});

describe("workflow handle finalization", () => {
  it("does not settle a starting handle and accepts a completed handle", () => {
    const cwd = temporaryDirectory("phenix-workflow-finalization");
    const params = {
      instanceId: "instance-finalization",
      actorId: "actor-finalization",
      sessionId: "session-finalization",
      definitionId: "phenix-default" as const,
      difficulty: "D0" as const,
      taskProfile: {
        complexity: 0,
        uncertainty: 0,
        consequence: 0,
        breadth: 0,
        coupling: 0,
        novelty: 0,
      },
      actorRole: "coordinator" as const,
      capabilityArtifactHash: "0".repeat(64),
    };

    const workflow = createWorkflowRecord(cwd, params);
    const begun = beginTransition(cwd, workflow, {
      expectedRevision: workflow.revision,
      transitionId: "d0.execute-base" as never,
      handleId: "handle-finalization",
    });

    const handle = {
      id: "handle-finalization",
      sessionId: params.sessionId,
      status: "starting",
      value: {},
      workflowBinding: {
        instanceId: params.instanceId,
        actorId: params.actorId,
        transitionExecutionId: begun.executionId,
        transitionId: "d0.execute-base",
        sourceState: "classified",
        sourceRevision: 0,
        acceptedState: "completed",
        rejectedState: "failed",
      },
    } as never;

    assert.equal(finalizeHandleWorkflow({ cwd, handle }), undefined);
    assert.equal(readWorkflowRecord(cwd, params.instanceId, params.actorId)?.active.length, 1);

    (handle as { status: string }).status = "completed";
    const finalized = finalizeHandleWorkflow({ cwd, handle });

    assert.ok(finalized);
    assert.equal(finalized.state, "completed");
    assert.equal(finalized.active.length, 0);
    assert.equal(finalized.completed.length, 1);
    assert.equal(finalized.completed[0]?.accepted, true);
  });

  it("throws when a terminal handle references a missing workflow record", () => {
    const cwd = temporaryDirectory("phenix-workflow-missing");
    const handle = {
      id: "missing-workflow-handle",
      sessionId: "missing-session",
      status: "failed",
      workflowBinding: {
        instanceId: "missing-instance",
        actorId: "missing-actor",
        transitionExecutionId: "wfexec-missing",
        transitionId: "d0.execute-base",
        sourceState: "classified",
        sourceRevision: 0,
        acceptedState: "completed",
        rejectedState: "failed",
      },
    } as never;

    assert.throws(
      () => finalizeHandleWorkflow({ cwd, handle }),
      /Workflow record not found while finalizing handle/,
    );
  });
});

describe("canonical runtime lifecycle policy", () => {
  it("uses executing as the base child initial state", () => {
    assert.equal(initialWorkflowStateForRole(null), "executing");
  });

  it("recognizes every persisted terminal handle state", () => {
    for (const status of ["completed", "failed", "cancelled", "orphaned"] as const) {
      assert.equal(isTerminalHandleStatus(status), true);
    }
    assert.equal(isTerminalHandleStatus("running"), false);
  });

  it("rejects a cancelled handle and clears its active workflow transition", () => {
    const cwd = temporaryDirectory("phenix-workflow-cancelled");
    const params = {
      instanceId: "instance-cancelled",
      actorId: "actor-cancelled",
      sessionId: "session-cancelled",
      definitionId: "phenix-default" as const,
      difficulty: "D0" as const,
      taskProfile: {
        complexity: 0,
        uncertainty: 0,
        consequence: 0,
        breadth: 0,
        coupling: 0,
        novelty: 0,
      },
      actorRole: "coordinator" as const,
      capabilityArtifactHash: "0".repeat(64),
    };
    const workflow = createWorkflowRecord(cwd, params);
    const begun = beginTransition(cwd, workflow, {
      expectedRevision: workflow.revision,
      transitionId: "d0.execute-base" as never,
      handleId: "handle-cancelled",
    });
    const handle = {
      id: "handle-cancelled",
      sessionId: params.sessionId,
      status: "cancelled",
      workflowBinding: {
        instanceId: params.instanceId,
        actorId: params.actorId,
        transitionExecutionId: begun.executionId,
        transitionId: "d0.execute-base",
        sourceState: "classified",
        sourceRevision: 0,
        acceptedState: "completed",
        rejectedState: "failed",
      },
    } as never;

    const finalized = finalizeHandleWorkflow({ cwd, handle });
    assert.ok(finalized);
    assert.equal(finalized.state, "failed");
    assert.equal(finalized.active.length, 0);
    assert.equal(finalized.completed.at(-1)?.accepted, false);
  });
});
