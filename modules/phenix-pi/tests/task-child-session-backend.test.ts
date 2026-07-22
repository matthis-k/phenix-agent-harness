import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionEvent,
  ChildSessionSpec,
  ContractSubmissionChannel,
} from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import { childRunId } from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import {
  createTaskBoundChildSessionBackend,
  taskRuntimeEnvironment,
} from "@matthis-k/phenix-suite/tasks/task-child-session-backend.ts";
import type { TaskWorkflowBridge } from "@matthis-k/phenix-suite/tasks/task-workflow-bridge.ts";
import { createTaskRuntimeFacade } from "@matthis-k/phenix-tasks/index.ts";

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

function childRun(): {
  readonly run: ChildRun;
  emit(event: ChildSessionEvent): void;
} {
  let listener: ((event: ChildSessionEvent) => void) | undefined;
  const run = {
    id: childRunId("child-test"),
    backend: "sdk",
    pi: { sessionId: "pi-child" },
    snapshot: () => ({}) as ReturnType<ChildRun["snapshot"]>,
    subscribe(next: (event: ChildSessionEvent) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async continue() {
      return { cycle: 1, status: "settled" } as const;
    },
    async waitForCurrentCycle() {
      return { cycle: 1, status: "settled" } as const;
    },
    async abort() {},
    async dispose() {},
  } satisfies ChildRun;
  return {
    run,
    emit(event) {
      listener?.(event);
    },
  };
}

function childSpec(channel: ContractSubmissionChannel): ChildSessionSpec {
  return {
    id: childRunId("child-test"),
    model: { provider: "console", id: "deepseek-v4" },
    thinkingLevel: "medium",
    parentContext: {},
    contractChannel: channel,
  } as unknown as ChildSessionSpec;
}

describe("task-bound child backend", () => {
  it("hands process authority to the backend, gates completion, and records failures", async () => {
    const tasks = createTaskRuntimeFacade();
    const authority = tasks.ensureWorkflow({
      workflowId: "wf_test",
      ownerSessionId: "root-session",
      rootActorId: "root-actor",
      title: "Test task-bound backend",
    });

    let capturedSpec: ChildSessionSpec | undefined;
    const child = childRun();
    const delegate: ChildSessionBackend = {
      kind: "sdk",
      async start(spec) {
        capturedSpec = spec;
        return child.run;
      },
    };
    const bridge = {
      claimChildAuthority: () => authority,
    } as unknown as TaskWorkflowBridge;
    let submissions = 0;
    const spec = childSpec(
      contractChannel(() => {
        submissions += 1;
      }),
    );

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

    child.emit({
      type: "agent.event",
      runId: childRunId("child-test"),
      event: {
        type: "error",
        code: "REPLICATION_FAILED",
        errorMessage: "Replication error from Console Go upstream.",
      },
    });
    child.emit({
      type: "session.failed",
      runId: childRunId("child-test"),
      error: {
        code: "PROVIDER_FAILED",
        message: "Replication error from Console Go upstream.",
      },
    });

    const diagnosticLog = tasks.readLog(authority.token, authority.scopeTaskId).log;
    const messages = diagnosticLog.map((entry) => entry.message).join("\n");
    assert.match(messages, /Child backend starting: backend=auto, preferred=sdk/);
    assert.match(messages, /model=console\/deepseek-v4/);
    assert.match(messages, /Contract submission blocked/);
    assert.match(messages, /Provider event type=error, code=REPLICATION_FAILED/);
    assert.match(messages, /Child session failed: code=PROVIDER_FAILED/);

    tasks.update(authority.token, { uid: authority.scopeTaskId, status: "done" });
    const accepted = await capturedSpec.contractChannel.submit({ result: "complete" });
    assert.equal(accepted.ok, true);
    assert.equal(submissions, 1);
  });

  it("records backend startup exceptions before rethrowing", async () => {
    const tasks = createTaskRuntimeFacade();
    const authority = tasks.ensureWorkflow({
      workflowId: "wf_start_failure",
      ownerSessionId: "root-session",
      rootActorId: "root-actor",
      title: "Test startup failure",
    });
    const delegate: ChildSessionBackend = {
      kind: "sdk",
      async start() {
        throw new Error("Replication service refused child startup.");
      },
    };
    const bridge = {
      claimChildAuthority: () => authority,
    } as unknown as TaskWorkflowBridge;
    const backend = createTaskBoundChildSessionBackend({
      delegate,
      tasks,
      getBridge: () => bridge,
      getEndpoint: async () => "unix:///tmp/phenix-tasks-test.sock",
    });

    await assert.rejects(
      backend.start(childSpec(contractChannel(() => undefined)), new AbortController().signal),
      /Replication service refused child startup/,
    );
    const messages = tasks
      .readLog(authority.token, authority.scopeTaskId)
      .log.map((entry) => entry.message)
      .join("\n");
    assert.match(messages, /Child backend start failed: Replication service refused child startup/);
  });
});
