import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PhenixTaskService } from "@matthis-k/phenix-tasks/index.ts";
import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionSpec,
  ContractSubmissionChannel,
} from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import {
  createTaskBoundChildSessionBackend,
  taskRuntimeEnvironment,
} from "@matthis-k/phenix-suite/tasks/task-child-session-backend.ts";
import type { TaskWorkflowBridge } from "@matthis-k/phenix-suite/tasks/task-workflow-bridge.ts";

function contractChannel(onSubmit: () => void): ContractSubmissionChannel {
  return {
    current: () => ({
      contractId: "contract_test",
      state: "pending",
      revision: 0,
      outputSchema: { type: "object" },
    }),
    async submit() {
      onSubmit();
      return { ok: true, state: "submitted", revision: 1 };
    },
    async reopen() {},
    async accept() {},
    async cancel() {},
    async readSubmitted() {
      return undefined;
    },
  };
}

describe("task-bound child backend", () => {
  it("hands process authority to the backend and gates completion", async () => {
    const tasks = new PhenixTaskService();
    const authority = tasks.ensureWorkflow({
      workflowId: "wf_test",
      ownerSessionId: "root-session",
      rootActorId: "root-actor",
      title: "Test task-bound backend",
    });

    let capturedSpec: ChildSessionSpec | undefined;
    const delegate: ChildSessionBackend = {
      kind: "sdk",
      async start(spec) {
        capturedSpec = spec;
        return {} as ChildRun;
      },
    };
    const bridge = {
      claimChildAuthority: () => authority,
    } as unknown as TaskWorkflowBridge;
    let submissions = 0;
    const spec = {
      id: "child-test",
      parentContext: {},
      contractChannel: contractChannel(() => {
        submissions += 1;
      }),
    } as unknown as ChildSessionSpec;

    const backend = createTaskBoundChildSessionBackend({
      delegate,
      tasks,
      getBridge: () => bridge,
      getEndpoint: async () => "unix:///tmp/phenix-tasks-test.sock",
    });
    await backend.start(spec, new AbortController().signal);

    assert.ok(capturedSpec);
    assert.deepEqual(taskRuntimeEnvironment(capturedSpec), {
      PHENIX_TASKS_ENDPOINT: "unix:///tmp/phenix-tasks-test.sock",
      PHENIX_TASKS_WORKFLOW_ID: "wf_test",
      PHENIX_TASKS_SCOPE_TASK_ID: authority.scopeTaskId,
      PHENIX_TASKS_CAPABILITY: authority.token,
    });

    const rejected = await capturedSpec.contractChannel.submit({ result: "too early" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.issues?.[0]?.code, "TASK_SUBTREE_INCOMPLETE");
    assert.equal(submissions, 0);

    tasks.updateTask(authority.token, { taskId: authority.scopeTaskId, state: "done" });
    const accepted = await capturedSpec.contractChannel.submit({ result: "complete" });
    assert.equal(accepted.ok, true);
    assert.equal(submissions, 1);
  });
});
