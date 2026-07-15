import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createWorkflowApiTools,
  createWorkflowInspectTool,
  createWorkflowSubagentTool,
  type WorkflowApiPort,
  type WorkflowAuthoritySnapshot,
} from "../extensions/phenix-runtime/workflow-api-tools.ts";

const AUTHORITY_DIGEST = "a".repeat(64);
const ctx = { cwd: "/tmp/workflow-api" } as ExtensionContext;

function snapshot(): WorkflowAuthoritySnapshot {
  return {
    source: "contract",
    role: "planner",
    effectiveTools: ["read", "phenix_workflow", "phenix_create_subagent"],
    delegation: {
      remainingDepth: 2,
      effectiveRoles: ["scout", "architect"],
      availableRoles: ["scout"],
    },
    workflow: {
      difficulty: "D2",
      currentState: "planning",
      revision: 7,
      optionsDigest: AUTHORITY_DIGEST,
      options: [
        {
          transitionId: "delegate-scout",
          workflowRevision: 7,
          role: "scout",
          purpose: "gather evidence",
          description: "Inspect the relevant implementation boundary.",
          category: "optional",
          outputSchemaId: "scout-result" as never,
          allowedModes: ["await"],
          resultSchema: { type: "object" },
        },
      ],
    },
  };
}

class RecordingWorkflow implements WorkflowApiPort {
  readonly delegateCalls: Parameters<WorkflowApiPort["delegate"]>[0][] = [];
  authority = snapshot();

  inspect(): WorkflowAuthoritySnapshot {
    return this.authority;
  }

  delegate(input: Parameters<WorkflowApiPort["delegate"]>[0]) {
    this.delegateCalls.push(input);
    return Promise.resolve({
      ok: true as const,
      record: { id: "handle-1", status: "running" },
    });
  }
}

async function execute(
  tool: ReturnType<typeof createWorkflowInspectTool> | ReturnType<typeof createWorkflowSubagentTool>,
  params: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  return tool.execute("call-1", params as never, signal, undefined, ctx);
}

describe("contract-bound workflow API tools", () => {
  it("exposes deterministic inspection for every Phenix model", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowInspectTool({ workflow });

    const result = await execute(tool, {});

    assert.equal(tool.name, "phenix_workflow");
    assert.deepEqual(result.details, snapshot());
  });

  it("installs creation only when contract initialization allows it", () => {
    const workflow = new RecordingWorkflow();

    assert.deepEqual(
      createWorkflowApiTools({ workflow, allowCreate: false }).map((tool) => tool.name),
      ["phenix_workflow"],
    );
    assert.deepEqual(
      createWorkflowApiTools({ workflow, allowCreate: true }).map((tool) => tool.name),
      ["phenix_workflow", "phenix_create_subagent"],
    );
  });

  it("binds fresh revision and authority digest at creation time", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowSubagentTool({ workflow });

    await execute(tool, {
      transitionId: "delegate-scout",
      task: "Inspect the workflow API boundary.",
      requirements: ["Return concrete evidence."],
    });

    assert.equal(workflow.delegateCalls.length, 1);
    assert.deepEqual(workflow.delegateCalls[0]?.params, {
      transitionId: "delegate-scout",
      task: "Inspect the workflow API boundary.",
      requirements: ["Return concrete evidence."],
      workflowRevision: 7,
      authorityDigest: AUTHORITY_DIGEST,
    });
  });

  it("rejects a stale or invented transition without delegating", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowSubagentTool({ workflow });

    const result = await execute(tool, {
      transitionId: "invented-transition",
      task: "Do something outside current authority.",
    });

    assert.equal(workflow.delegateCalls.length, 0);
    assert.match(result.content[0]?.text ?? "", /not currently legal/);
    assert.deepEqual(result.details?.available, [
      {
        transitionId: "delegate-scout",
        role: "scout",
        category: "optional",
        allowedModes: ["await"],
      },
    ]);
  });
});
