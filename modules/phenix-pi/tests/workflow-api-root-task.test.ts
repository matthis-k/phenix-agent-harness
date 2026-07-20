import assert from "node:assert/strict";
import { it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool } from "@matthis-k/phenix-suite/runtime/workflow-api-tools.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowRuntimePort,
} from "@matthis-k/phenix-suite/runtime/workflow-runtime-types.ts";

const ctx = { cwd: "/tmp/workflow-root-task" } as ExtensionContext;

it("forwards the canonical root user task separately from model focus", async () => {
  const calls: Parameters<WorkflowRuntimePort["spawn"]>[0][] = [];
  const workflow: WorkflowRuntimePort = {
    inspect(): WorkflowAuthoritySnapshot {
      throw new Error("inspect is not used by this test");
    },
    async spawn(input) {
      calls.push(input);
      return {
        ok: true,
        transition: { agent: "base", fromNodeId: "classified", toNodeId: "completed" },
        record: { id: "handle-1", status: "completed" },
      };
    },
  };
  const tool = createWorkflowTool({
    workflow,
    rootUserTask: () => "Do a full QA pass on this repository.",
  });

  await tool.execute(
    "call-1",
    {
      action: "spawn",
      agent: "base",
      task: "Run only the QA skeleton command.",
    },
    new AbortController().signal,
    undefined,
    ctx,
  );

  assert.equal(calls[0]?.task, "Run only the QA skeleton command.");
  assert.equal(calls[0]?.userTask, "Do a full QA pass on this repository.");
});
