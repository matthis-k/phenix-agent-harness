import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelSetId } from "../extensions/phenix-kernel/ids.ts";
import { routing } from "../extensions/phenix-runtime/index.ts";
import type { RuntimeBindings } from "../extensions/phenix-runtime/execution-plan.ts";
import { returns } from "../extensions/phenix-runtime/subagent-api.ts";
import {
  createWorkflowExecutionCompiler,
  WorkflowExecutionCompiler,
} from "../extensions/phenix-subagents/workflow-execution-compiler.ts";

const runtime = {
  id: "child-test",
  rootId: "child-test",
  handleId: "handle-test",
} as unknown as RuntimeBindings;

describe("WorkflowExecutionCompiler", () => {
  it("compiles public requests under workflow-owned authority", async () => {
    const compiler = createWorkflowExecutionCompiler({
      role: "planner",
      modelSet: modelSetId("mixed"),
      difficulty: "D2",
      thinking: "high",
      persistence: "file",
      runtime,
      acceptanceKind: "workflow-producer",
      acceptanceData: { handleId: "handle-test" },
    });
    const output = returns<{ readonly plan: string }>({ type: "object" });

    const plan = await compiler.compile(
      {
        task: "Plan the implementation.",
        requirements: ["Keep the routing boundary explicit."],
        returns: output,
        session: {
          agent: "scout",
          model: routing.get("architect"),
          thinking: "low",
          persistence: "memory",
        },
      },
      new AbortController().signal,
    );

    assert.deepEqual(plan.assignment, {
      task: "Plan the implementation.",
      requirements: ["Keep the routing boundary explicit."],
    });
    assert.equal(plan.session.options?.agent, "planner");
    assert.deepEqual(plan.session.options?.model, routing.get("architect"));
    assert.equal(plan.session.options?.thinking, "high");
    assert.equal(plan.session.options?.persistence, "file");
    assert.equal(plan.session.defaults.difficulty, "D2");
    assert.equal(plan.runtime, runtime);
    assert.equal(plan.acceptance.kind, "workflow-producer");
    assert.equal(plan.acceptance.returns, output);
    assert.deepEqual(plan.acceptance.data, { handleId: "handle-test" });
  });

  it("rejects compilation when the execution scope is already aborted", async () => {
    const compiler = new WorkflowExecutionCompiler({
      role: "scout",
      modelSet: modelSetId("mixed"),
      difficulty: "D1",
      thinking: "low",
      persistence: "memory",
      runtime,
    });
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await assert.rejects(
      compiler.compile(
        {
          task: "Inspect the repository.",
          returns: returns({ type: "object" }),
        },
        controller.signal,
      ),
      /stop/,
    );
  });
});
