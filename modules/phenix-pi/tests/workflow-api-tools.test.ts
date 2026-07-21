import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createDirectSubagentTool,
  createWorkflowApiTools,
  createWorkflowTool,
  projectWorkflowInspection,
  WorkflowToolError,
} from "@matthis-k/phenix-suite/runtime/workflow-api-tools.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowRuntimePort,
  WorkflowSpawnResult,
} from "@matthis-k/phenix-suite/runtime/workflow-runtime-types.ts";

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
  tool: ReturnType<typeof createWorkflowTool> | ReturnType<typeof createDirectSubagentTool>,
  params: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  return tool.execute("call-1", params as never, signal, undefined, ctx);
}

async function assertToolFailure(
  promise: Promise<unknown>,
  expectedDetails: Record<string, unknown>,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkflowToolError);
    assert.deepEqual(error.details, expectedDetails);
    return true;
  });
}

describe("contract-bound workflow target-agent tools", () => {
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

  it("installs workflow and gated direct-subagent tools", () => {
    const workflow = new RecordingWorkflow();
    assert.deepEqual(
      createWorkflowApiTools({ workflow }).map((tool) => tool.name),
      ["phenix_workflow", "phenix_subagent"],
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

    await assertToolFailure(
      execute(tool, {
        action: "spawn",
        agent: "scout",
        task: "Inspect something.",
      }),
      { status: "forbidden", tool: "phenix_workflow" },
    );

    assert.equal(workflow.spawnCalls.length, 0);
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
      mode: "await",
      signal,
      ctx,
    });
    assert.deepEqual(response.details, {
      agent: "scout",
      fromNodeId: "planning",
      toNodeId: "planning",
      handleId: "handle-1",
      subagentId: undefined,
      handle: {
        id: "handle-1",
        tool: "phenix_agent",
        actions: ["inspect", "poll", "await", "send", "cancel"],
      },
      status: "running",
      value: undefined,
      error: undefined,
      errors: undefined,
    });
  });

  it("keeps the parent-facing tool call open until awaited execution settles", async () => {
    let resolveExecution!: (result: WorkflowSpawnResult) => void;
    const completion = new Promise<WorkflowSpawnResult>((resolve) => {
      resolveExecution = resolve;
    });
    const spawnCalls: Parameters<WorkflowRuntimePort["spawn"]>[0][] = [];
    const workflow: WorkflowRuntimePort = {
      inspect: snapshot,
      spawn(input) {
        spawnCalls.push(input);
        return completion;
      },
    };
    const tool = createWorkflowTool({ workflow });
    let returned = false;
    const responsePromise = execute(tool, {
      action: "spawn",
      agent: "scout",
      task: "Inspect the parent return boundary.",
    }).then((response) => {
      returned = true;
      return response;
    });

    await Promise.resolve();
    assert.equal(spawnCalls[0]?.mode, "await");
    assert.equal(returned, false);

    resolveExecution({
      ok: true,
      transition: {
        agent: "scout",
        fromNodeId: "planning",
        toNodeId: "planning",
      },
      record: { id: "handle-return", status: "completed", value: { summary: "done" } },
    });

    const response = await responsePromise;
    assert.equal(returned, true);
    assert.equal(response.details?.status, "completed");
    assert.deepEqual(response.details?.value, { summary: "done" });
  });

  it("defaults child-local workflow execution to await", async () => {
    const workflow = new RecordingWorkflow();
    const parent = { kind: "child" } as never;
    const tool = createWorkflowTool({ workflow, parent });

    await execute(tool, {
      action: "spawn",
      agent: "scout",
      task: "Inspect the child boundary.",
    });

    assert.equal(workflow.spawnCalls[0]?.mode, "await");
  });

  it("preserves explicit background execution as a handle-managed opt-in", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });

    await execute(tool, {
      action: "spawn",
      agent: "scout",
      task: "Inspect independently.",
      mode: "background",
    });

    assert.equal(workflow.spawnCalls[0]?.mode, "background");
  });

  it("normalizes JSON-encoded requirement arrays from model transports", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });

    await execute(tool, {
      action: "spawn",
      agent: "scout",
      task: "Inspect the boundary.",
      requirements: '["Return evidence", "Do not edit"]',
    });

    assert.deepEqual(workflow.spawnCalls[0]?.requirements, ["Return evidence", "Do not edit"]);
    assert.equal(workflow.spawnCalls[0]?.mode, "await");
  });

  it("marks backend authority failures as tool errors", async () => {
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

    await assertToolFailure(
      execute(tool, {
        action: "spawn",
        agent: "scout",
        task: "Inspect something.",
      }),
      {
        code: "WORKFLOW_AGENT_NOT_AVAILABLE",
        currentNodeId: "reviewing",
      },
    );

    assert.equal(workflow.spawnCalls.length, 1);
  });

  it("denies the direct tool unless current authority enables it", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createDirectSubagentTool({ workflow });

    workflow.authority = {
      ...workflow.authority,
      workflow: { ...workflow.authority.workflow, options: [] },
    };
    await assertToolFailure(execute(tool, { task: "Inspect directly." }), {
      code: "DIRECT_SUBAGENT_NOT_DETERMINISTIC",
      availableAgents: [],
    });

    assert.equal(workflow.spawnCalls.length, 0);
  });

  it("directly spawns the sole legal target when explicitly authorized", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createDirectSubagentTool({ workflow });

    const response = await execute(tool, {
      task: "Inspect directly.",
      requirements: "Return evidence.",
    });

    assert.equal(response.details?.agent, "scout");
    assert.equal(workflow.spawnCalls[0]?.agent, "scout");
    assert.deepEqual(workflow.spawnCalls[0]?.requirements, ["Return evidence."]);
    assert.equal(workflow.spawnCalls[0]?.mode, "await");
  });
});
