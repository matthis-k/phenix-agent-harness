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
  WorkflowRuntimePort,
  WorkflowSpawnResult,
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
          agent: "scout",
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
  readonly spawnCalls: Parameters<WorkflowRuntimePort["spawn"]>[0][] = [];
  inspectCalls = 0;
  authority = snapshot();
  execution: WorkflowSpawnResult = {
    ok: true,
    transition: {
      agent: "scout",
      fromNodeId: "planning",
      toNodeId: "planning",
    },
    record: { id: "handle-1", status: "running" },
  };

  inspect(): WorkflowAuthoritySnapshot {
    this.inspectCalls += 1;
    return this.authority;
  }

  spawn(input: Parameters<WorkflowRuntimePort["spawn"]>[0]) {
    this.spawnCalls.push(input);
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

describe("contract-bound workflow target-agent tool", () => {
  it("projects the authority snapshot without exposing transition identities", () => {
    const response = projectWorkflowInspection(snapshot());

    assert.deepEqual(response, {
      actor: { source: "contract", role: "planner" },
      node: { nodeId: "planning", difficulty: "D2", revision: 7 },
      agents: [
        {
          agent: "scout",
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
      ],
      authority: {
        remainingDelegationDepth: 2,
        effectiveTools: ["read", "phenix_workflow"],
      },
    });
    assert.doesNotMatch(JSON.stringify(response), /optionsDigest|transitionId|edgeId/);
  });

  it("installs one stable workflow tool", () => {
    const workflow = new RecordingWorkflow();
    assert.deepEqual(
      createWorkflowApiTools({ workflow }).map((tool) => tool.name),
      ["phenix_workflow"],
    );
  });

  it("returns fresh authority through inspect without spawning", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });

    const response = await execute(tool, { action: "inspect" });

    assert.equal(workflow.inspectCalls, 1);
    assert.equal(workflow.spawnCalls.length, 0);
    assert.deepEqual(response.details, projectWorkflowInspection(workflow.authority));
  });

  it("applies root-scope authorization before spawning", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({
      workflow,
      authorize: ({ tool: toolName }) => `${toolName} is outside this root model scope.`,
    });

    const response = await execute(tool, {
      action: "spawn",
      agent: "scout",
      task: "Inspect something.",
    });

    assert.equal(workflow.spawnCalls.length, 0);
    assert.deepEqual(response.details, {
      status: "forbidden",
      tool: "phenix_workflow",
    });
  });

  it("passes only target intent and assignment to the runtime", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });
    const signal = new AbortController().signal;

    const response = await execute(
      tool,
      {
        action: "spawn",
        agent: "scout",
        task: "Inspect the workflow API boundary.",
        requirements: ["Return concrete evidence."],
      },
      signal,
    );

    assert.deepEqual(workflow.spawnCalls[0], {
      agent: "scout",
      task: "Inspect the workflow API boundary.",
      requirements: ["Return concrete evidence."],
      signal,
      ctx,
    });
    assert.deepEqual(response.details, {
      agent: "scout",
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
      message: "The target agent is no longer legal from the current contract-bound node.",
      details: {
        code: "WORKFLOW_AGENT_NOT_AVAILABLE",
        currentNodeId: "reviewing",
      },
    };
    const tool = createWorkflowTool({ workflow });

    const response = await execute(tool, {
      action: "spawn",
      agent: "scout",
      task: "Inspect something.",
    });

    assert.equal(workflow.spawnCalls.length, 1);
    assert.equal(response.details?.code, "WORKFLOW_AGENT_NOT_AVAILABLE");
    assert.equal(response.details?.currentNodeId, "reviewing");
  });
});
