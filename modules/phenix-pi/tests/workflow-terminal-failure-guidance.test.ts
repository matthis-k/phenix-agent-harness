import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowTool,
  WorkflowToolError,
} from "@matthis-k/phenix-suite/runtime/workflow-api-tools.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowRuntimePort,
} from "@matthis-k/phenix-suite/runtime/workflow-runtime-types.ts";

const ctx = { cwd: "/tmp/workflow-terminal-failure" } as ExtensionContext;

function terminalSnapshot(): WorkflowAuthoritySnapshot {
  return {
    source: "contract",
    role: null,
    effectiveTools: ["phenix_workflow"],
    delegation: {
      remainingDepth: 0,
      effectiveRoles: [],
      availableRoles: [],
    },
    workflow: {
      difficulty: "D2",
      currentState: "failed",
      revision: 8,
      optionsDigest: "a".repeat(64),
      options: [],
    },
  };
}

describe("terminal workflow failure guidance", () => {
  it("tells the parent not to retry a failed required transition", async () => {
    const workflow: WorkflowRuntimePort = {
      inspect: terminalSnapshot,
      spawn: async () => ({
        ok: false,
        message: "Tool budget exceeded: 81 calls, hard limit is 80.",
        details: { code: "TOOL_BUDGET_EXCEEDED" },
      }),
    };
    const tool = createWorkflowTool({ workflow });

    await assert.rejects(
      tool.execute(
        "call-terminal",
        {
          action: "spawn",
          agent: "base",
          task: "Perform a full repository QA.",
        },
        new AbortController().signal,
        undefined,
        ctx,
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowToolError);
        assert.match(error.message, /terminal \(failed\)/);
        assert.match(error.message, /do not retry this transition/);
        assert.deepEqual(error.details, {
          code: "TOOL_BUDGET_EXCEEDED",
          currentState: "failed",
          workflowRevision: 8,
        });
        return true;
      },
    );
  });
});
