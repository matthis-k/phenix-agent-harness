import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createWorkflowApiTools,
  createWorkflowTool,
  projectWorkflowInspection,
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

describe("contract-bound workflow edge tool", () => {
  it("projects the authority snapshot for deterministic prompt bootstrap", () => {
    const response = projectWorkflowInspection(snapshot());

    assert.deepEqual(response, {
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
    assert.doesNotMatch(JSON.stringify(response), /optionsDigest|transitionId/);
  });

  it("installs one stable workflow tool", () => {
    const workflow = new RecordingWorkflow();
    assert.deepEqual(
      createWorkflowApiTools({ workflow }).map((tool) => tool.name),
      ["phenix_workflow"],
    );
  });

  it("applies root-scope authorization before edge invocation", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({
      workflow,
      authorize: ({ tool: toolName }) => `${toolName} is outside this root model scope.`,
    });

    const response = await execute(tool, {
      edgeId: "planner.request-scout",
      spawn: { task: "Inspect something." },
    });

    assert.equal(workflow.takeEdgeCalls.length, 0);
    assert.deepEqual(response.details, {
      status: "forbidden",
      tool: "phenix_workflow",
    });
  });

  it("passes only the selected edge and edge input to the runtime", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });
    const signal = new AbortController().signal;

    const response = await execute(
      tool,
      {
        edgeId: "planner.request-scout",
        spawn: {
          task: "Inspect the workflow API boundary.",
          requirements: ["Return concrete evidence."],
        },
      },
      signal,
    );

    assert.deepEqual(workflow.takeEdgeCalls[0], {
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

  it("propagates fresh backend authority failures", async () => {
    const workflow = new RecordingWorkflow();
    workflow.execution = {
      ok: false,
      message: "The edge is no longer legal from the current contract-bound node.",
      details: {
        code: "WORKFLOW_EDGE_NOT_AVAILABLE",
        currentNodeId: "reviewing",
      },
    };
    const tool = createWorkflowTool({ workflow });

    const response = await execute(tool, {
      edgeId: "planner.request-scout",
      spawn: { task: "Inspect something." },
    });

    assert.equal(workflow.takeEdgeCalls.length, 1);
    assert.equal(response.details?.code, "WORKFLOW_EDGE_NOT_AVAILABLE");
    assert.equal(response.details?.currentNodeId, "reviewing");
  });
});
