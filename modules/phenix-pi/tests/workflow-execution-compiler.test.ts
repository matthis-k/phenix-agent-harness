import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";

import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";
import type { RuntimeBindings } from "@matthis-k/phenix-suite/runtime/execution-plan.ts";
import { routing } from "@matthis-k/phenix-suite/runtime/index.ts";
import { returns } from "@matthis-k/phenix-suite/runtime/subagent-api.ts";
import {
  createWorkflowExecutionCompiler,
  WorkflowExecutionCompiler,
} from "@matthis-k/phenix-suite/subagents/workflow-execution-compiler.ts";

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
    const output = returns(
      Type.Object({
        plan: Type.String(),
      }),
    );

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
          returns: returns(Type.Object({})),
        },
        controller.signal,
      ),
      /stop/,
    );
  });
});
