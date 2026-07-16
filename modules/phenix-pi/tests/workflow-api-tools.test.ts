import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createWorkflowApiTools,
  createWorkflowTool,
} from "../extensions/phenix-runtime/workflow-api-tools.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowEdgeExecutionResult,
  WorkflowRuntimePort,
} from "../extensions/phenix-runtime/workflow-runtime-types.ts";

const AUTHORITY_DIGEST = "a".repeat(64);
const ctx = { cwd: "/tmp/workflow-api" } as ExtensionContext;

function snapshot(): WorkflowAuthoritySnapshot {
  return {
    source: "contract",
    role: "planner",
    effectiveTools: ["read", "phenix_workflow"],
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
          edgeId: "planner.request-scout",
          transitionId: "planner.request-scout",
          sourceNodeId: "planning",
          targetNodeId: "planning",
          workflowRevision: 7,
          role: "scout",
          purpose: "gather evidence",
          description: "Inspect the relevant implementation boundary.",
          category: "optional",
          outputSchemaId: "scout-handoff",
          allowedModes: ["await"],
          resultSchema: { type: "object" },
        },
      ],
    },
  };
}

class RecordingWorkflow implements WorkflowRuntimePort {
  readonly takeEdgeCalls: Parameters<WorkflowRuntimePort["takeEdge"]>[0][] = [];
  inspectCalls = 0;
  authority = snapshot();
  execution: WorkflowEdgeExecutionResult = {
    ok: true,
    edge: {
      edgeId: "planner.request-scout",
      fromNodeId: "planning",
      toNodeId: "planning",
    },
    record: { id: "handle-1", status: "running" },
  };

  inspect(): WorkflowAuthoritySnapshot {
    this.inspectCalls += 1;
    return this.authority;
  }

  takeEdge(input: Parameters<WorkflowRuntimePort["takeEdge"]>[0]) {
    this.takeEdgeCalls.push(input);
    return Promise.resolve(this.execution);
  }
}

async function execute(
  tool: ReturnType<typeof createWorkflowTool>,
  params: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  return tool.execute("call-1", params as never, signal, undefined, ctx);
}

describe("contract-bound workflow graph tool", () => {
  it("exposes the current node and legal outgoing edges", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });

    const response = await execute(tool, { action: "inspect" });

    assert.deepEqual(response.details, {
      actor: { source: "contract", role: "planner" },
      node: { nodeId: "planning", difficulty: "D2", revision: 7 },
      edges: [
        {
          edgeId: "planner.request-scout",
          kind: "spawn",
          fromNodeId: "planning",
          toNodeId: "planning",
          spawn: {
            role: "scout",
            purpose: "gather evidence",
            description: "Inspect the relevant implementation boundary.",
            category: "optional",
            modes: ["await"],
            returns: {
              schemaId: "scout-handoff",
              schema: { type: "object" },
            },
          },
        },
      ],
      authority: {
        remainingDelegationDepth: 2,
        effectiveTools: ["read", "phenix_workflow"],
      },
    });
    assert.doesNotMatch(JSON.stringify(response.details), /optionsDigest|transitionId/);
  });

  it("installs one stable workflow tool", () => {
    const workflow = new RecordingWorkflow();
    assert.deepEqual(createWorkflowApiTools({ workflow }).map((tool) => tool.name), [
      "phenix_workflow",
    ]);
  });

  it("applies root-scope authorization before inspection", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({
      workflow,
      authorize: ({ tool: toolName }) => `${toolName} is outside this root model scope.`,
    });

    const response = await execute(tool, { action: "inspect" });

    assert.equal(workflow.inspectCalls, 0);
    assert.deepEqual(response.details, {
      status: "forbidden",
      tool: "phenix_workflow",
    });
  });

  it("maps a spawn edge call onto the workflow runtime port", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });
    const signal = new AbortController().signal;

    const response = await execute(
      tool,
      {
        action: "take",
        nodeId: "planning",
        edgeId: "planner.request-scout",
        spawn: {
          task: "Inspect the workflow API boundary.",
          requirements: ["Return concrete evidence."],
        },
      },
      signal,
    );

    assert.deepEqual(workflow.takeEdgeCalls[0], {
      expectedNodeId: "planning",
      edgeId: "planner.request-scout",
      input: {
        kind: "spawn",
        task: "Inspect the workflow API boundary.",
        requirements: ["Return concrete evidence."],
      },
      signal,
      ctx,
    });
    assert.deepEqual(response.details, {
      edgeId: "planner.request-scout",
      fromNodeId: "planning",
      toNodeId: "planning",
      handleId: "handle-1",
      status: "running",
      value: undefined,
      error: undefined,
    });
  });

  it("propagates deterministic workflow-runtime failures", async () => {
    const workflow = new RecordingWorkflow();
    workflow.execution = {
      ok: false,
      message: "The expected node is stale.",
      details: {
        code: "WORKFLOW_NODE_STALE",
        currentNodeId: "planning",
      },
    };
    const tool = createWorkflowTool({ workflow });

    const response = await execute(tool, {
      action: "take",
      nodeId: "classified",
      edgeId: "planner.request-scout",
      spawn: { task: "Inspect something." },
    });

    assert.equal(workflow.takeEdgeCalls.length, 1);
    assert.equal(response.details?.code, "WORKFLOW_NODE_STALE");
    assert.equal(response.details?.currentNodeId, "planning");
  });
});
