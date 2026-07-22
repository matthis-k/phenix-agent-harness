import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildParentExecutionContext } from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowRuntimePort,
  WorkflowSpawnRequest,
} from "@matthis-k/phenix-suite/runtime/workflow-runtime-types.ts";
import { createTaskWorkflowBridge } from "@matthis-k/phenix-suite/tasks/task-workflow-bridge.ts";
import { createTaskRuntimeFacade } from "@matthis-k/phenix-tasks/index.ts";

const AUTHORITY_DIGEST = "a".repeat(64);

function context(): ExtensionContext {
  return {
    cwd: "/tmp/phenix-task-diagnostics",
    sessionManager: { getSessionId: () => "root-session" },
  } as unknown as ExtensionContext;
}

function authority(): WorkflowAuthoritySnapshot {
  return {
    source: "root",
    role: "coordinator",
    effectiveTools: [],
    delegation: {
      remainingDepth: 3,
      effectiveRoles: ["base"],
      availableRoles: ["base"],
    },
    workflow: {
      difficulty: "D0",
      currentState: "classified",
      revision: 1,
      optionsDigest: AUTHORITY_DIGEST,
      options: [
        {
          agent: "base",
          transitionId: "d0.execute",
          sourceNodeId: "classified",
          targetNodeId: "completed",
          workflowRevision: 1,
          role: null,
          purpose: "execute",
          description: "Execute the complete bounded non-code task.",
          category: "required",
          outputSchemaId: "base-handoff",
          allowedModes: ["await"],
          resultSchema: { type: "object" },
        },
      ],
    },
  };
}

function terminalAuthority(): WorkflowAuthoritySnapshot {
  return {
    ...authority(),
    delegation: {
      remainingDepth: 3,
      effectiveRoles: [],
      availableRoles: [],
    },
    workflow: {
      difficulty: "D3",
      currentState: "completed",
      revision: 2,
      optionsDigest: "b".repeat(64),
      options: [],
    },
  };
}

function unusedWorkflow(): WorkflowRuntimePort {
  return {
    inspect: authority,
    async spawn() {
      throw new Error("not used");
    },
  };
}

function childParent(input: {
  readonly workflowId: string;
  readonly actorId: string;
  readonly parentActorId: string;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly taskAuthoritySource?: "runtime-internal";
}): ChildParentExecutionContext {
  return {
    kind: "child",
    sessionId: "root-session",
    cwd: "/tmp/phenix-task-diagnostics",
    contractId: `contract-${input.actorId}`,
    contract: {
      assignment: {
        task: input.task,
        requirements: input.requirements,
        outputSchema: { type: "object" },
      },
      runtime: {
        workflow: {
          instanceId: input.workflowId,
          actorId: input.actorId,
          parentActorId: input.parentActorId,
        },
      },
    },
    handleId: `handle-${input.actorId}`,
    childRunId: `run-${input.actorId}`,
    rootChildRunId: "run-producer",
    modelSet: "mixed",
    maximumDelegationDepth: 0,
    ...(input.taskAuthoritySource ? { taskAuthoritySource: input.taskAuthoritySource } : {}),
  } as unknown as ChildParentExecutionContext;
}

describe("task workflow diagnostics", () => {
  it("records the complete workflow failure before marking the task failed", async () => {
    const tasks = createTaskRuntimeFacade();
    const root = tasks.ensureWorkflow({
      workflowId: "wf_failure",
      ownerSessionId: "root-session",
      rootActorId: "root-actor",
      title: "Diagnose delegation",
    });
    const workflow: WorkflowRuntimePort = {
      inspect: authority,
      async spawn() {
        return {
          ok: false,
          message: "Replication error from Console Go upstream.",
          details: {
            code: "PROVIDER_FAILED",
            handleId: "handle-1",
            status: "failed",
            errors: ["PROVIDER_FAILED: Replication error from Console Go upstream."],
          },
        };
      },
    };
    const bridge = createTaskWorkflowBridge({ workflow, tasks });

    const result = await bridge.workflow.spawn({
      agent: "scout",
      task: "Inspect provider replication failure",
      requirements: ["Capture the original error"],
      mode: "await",
      signal: new AbortController().signal,
      ctx: context(),
    });

    assert.equal(result.ok, false);
    const delegated = tasks.inspect(root.token).children[0];
    assert.ok(delegated);
    const messages = tasks
      .readLog(root.token, delegated.uid)
      .log.map((entry) => entry.message)
      .join("\n");
    assert.match(messages, /Delegation requested: agent=scout, mode=await/);
    assert.match(messages, /code=PROVIDER_FAILED/);
    assert.match(messages, /handle=handle-1/);
    assert.match(messages, /Replication error from Console Go upstream/);
  });

  it("queues and claims the same canonical required-root assignment", async () => {
    const tasks = createTaskRuntimeFacade();
    tasks.ensureWorkflow({
      workflowId: "wf_canonical",
      ownerSessionId: "root-session",
      rootActorId: "root-actor",
      title: "Full repository QA",
    });
    let forwarded: WorkflowSpawnRequest | undefined;
    const workflow: WorkflowRuntimePort = {
      inspect: authority,
      async spawn(request) {
        forwarded = request;
        return {
          ok: true,
          transition: {
            agent: "base",
            fromNodeId: "classified",
            toNodeId: "completed",
          },
          record: { id: "handle-canonical", status: "running" },
        };
      },
    };
    const bridge = createTaskWorkflowBridge({ workflow, tasks });

    await bridge.workflow.spawn({
      agent: "base",
      task: "Run only the deterministic QA skeleton.",
      userTask: "Do a full QA pass on this repository.",
      mode: "await",
      signal: new AbortController().signal,
      ctx: context(),
    });

    assert.ok(forwarded);
    assert.match(forwarded.task, /Execute the complete bounded non-code task/);
    assert.match(forwarded.task, /Do a full QA pass on this repository/);
    assert.ok(forwarded.requirements?.some((item) => /entire user request/i.test(item)));

    const childAuthority = tasks.claimDelegation({
      workflowId: "wf_canonical",
      parentActorId: "root-actor",
      childActorId: "child-base",
      childSessionId: "child-run",
      task: forwarded.task,
      requirements: forwarded.requirements,
    });
    assert.equal(childAuthority.actorId, "child-base");
  });

  it("prepares task ownership for a runtime-owned semantic critic", () => {
    const tasks = createTaskRuntimeFacade();
    const root = tasks.ensureWorkflow({
      workflowId: "wf_runtime_critic",
      ownerSessionId: "root-session",
      rootActorId: "root-actor",
      title: "Review a QA producer",
    });
    const producerTask = "Produce the QA evidence";
    const producerRequirements = ["Return structured evidence"];
    tasks.prepareDelegation(root.token, {
      task: producerTask,
      requirements: producerRequirements,
    });
    const producer = tasks.claimDelegation({
      workflowId: "wf_runtime_critic",
      parentActorId: "root-actor",
      childActorId: "producer-actor",
      childSessionId: "run-producer",
      task: producerTask,
      requirements: producerRequirements,
    });
    const bridge = createTaskWorkflowBridge({ workflow: unusedWorkflow(), tasks });

    const critic = bridge.claimChildAuthority(
      childParent({
        workflowId: "wf_runtime_critic",
        actorId: "critic-actor",
        parentActorId: "producer-actor",
        task: "Review the producer result",
        requirements: ["Return an independent verdict"],
        taskAuthoritySource: "runtime-internal",
      }),
    );

    assert.equal(critic.actorId, "critic-actor");
    assert.equal(critic.sessionId, "run-critic-actor");
    const producerTree = tasks.inspect(producer.token);
    assert.equal(producerTree.children.length, 1);
    assert.equal(producerTree.children[0]?.name, "Review the producer result");
    assert.equal(producerTree.children[0]?.assignedSessionId, "run-critic-actor");
  });

  it("keeps unmatched ordinary workflow claims strict", () => {
    const tasks = createTaskRuntimeFacade();
    const root = tasks.ensureWorkflow({
      workflowId: "wf_strict_claim",
      ownerSessionId: "root-session",
      rootActorId: "root-actor",
      title: "Strict workflow child claims",
    });
    const producerTask = "Produce the primary result";
    tasks.prepareDelegation(root.token, { task: producerTask });
    tasks.claimDelegation({
      workflowId: "wf_strict_claim",
      parentActorId: "root-actor",
      childActorId: "producer-actor",
      childSessionId: "run-producer",
      task: producerTask,
    });
    const bridge = createTaskWorkflowBridge({ workflow: unusedWorkflow(), tasks });

    assert.throws(
      () =>
        bridge.claimChildAuthority(
          childParent({
            workflowId: "wf_strict_claim",
            actorId: "ordinary-child",
            parentActorId: "producer-actor",
            task: "Unprepared child task",
            requirements: [],
          }),
        ),
      /No pending task delegation exists for actor producer-actor in wf_strict_claim/,
    );
  });

  it("reconciles the root task when the workflow is terminal", () => {
    const tasks = createTaskRuntimeFacade();
    const root = tasks.ensureWorkflow({
      workflowId: "wf_terminal",
      ownerSessionId: "root-session",
      rootActorId: "root-actor",
      title: "Full repository QA",
    });
    const child = tasks.add(root.token, { name: "Integrate QA results" });
    tasks.update(root.token, { uid: child.uid, status: "done" });

    const workflow: WorkflowRuntimePort = {
      inspect: terminalAuthority,
      async spawn() {
        throw new Error("not used");
      },
    };
    const bridge = createTaskWorkflowBridge({ workflow, tasks });

    bridge.workflow.inspect({ ctx: context() });

    assert.deepEqual(tasks.summary("wf_terminal"), {
      total: 2,
      notStarted: 0,
      wip: 0,
      done: 2,
    });
    assert.equal(tasks.inspect(root.token).ownStatus, "done");
  });
});
