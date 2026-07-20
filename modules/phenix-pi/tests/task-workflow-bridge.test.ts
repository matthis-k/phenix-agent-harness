import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowRuntimePort } from "@matthis-k/phenix-suite/runtime/workflow-runtime-types.ts";
import { createTaskWorkflowBridge } from "@matthis-k/phenix-suite/tasks/task-workflow-bridge.ts";
import { createTaskRuntimeFacade } from "@matthis-k/phenix-tasks/index.ts";

function context(): ExtensionContext {
  return {
    cwd: "/tmp/phenix-task-diagnostics",
    sessionManager: { getSessionId: () => "root-session" },
  } as unknown as ExtensionContext;
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
      inspect() {
        throw new Error("not used");
      },
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
});
