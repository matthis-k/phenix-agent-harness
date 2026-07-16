import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createWorkflowApiTools,
  createWorkflowTool,
  type WorkflowApiPort,
  type WorkflowAuthoritySnapshot,
} from "../extensions/phenix-runtime/workflow-api-tools.ts";

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

class RecordingWorkflow implements WorkflowApiPort {
  readonly delegateCalls: Parameters<WorkflowApiPort["delegate"]>[0][] = [];
  inspectCalls = 0;
  authority = snapshot();

  inspect(): WorkflowAuthoritySnapshot {
    this.inspectCalls += 1;
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
  tool: ReturnType<typeof createWorkflowTool>,
  params: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  return tool.execute("call-1", params as never, signal, undefined, ctx);
}

describe("contract-bound workflow action tool", () => {
  it("exposes a sanitized actor-scoped inspection", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });

    const response = await execute(tool, { action: "inspect" });

    assert.equal(tool.name, "phenix_workflow");
    assert.deepEqual(response.details, {
      actor: { source: "contract", role: "planner" },
      state: { id: "planning", difficulty: "D2", revision: 7 },
      authority: {
        remainingDelegationDepth: 2,
        effectiveTools: ["read", "phenix_workflow"],
      },
      actions: {
        delegate: [
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
      },
    });
    assert.doesNotMatch(JSON.stringify(response.details), /transitionId|optionsDigest/);
  });

  it("installs one stable workflow tool regardless of current delegation authority", () => {
    const workflow = new RecordingWorkflow();

    assert.deepEqual(
      createWorkflowApiTools({ workflow, allowCreate: false }).map((tool) => tool.name),
      ["phenix_workflow"],
    );
    assert.deepEqual(
      createWorkflowApiTools({ workflow, allowCreate: true }).map((tool) => tool.name),
      ["phenix_workflow"],
    );
  });

  it("applies an injected root-scope authorizer before reading authority", async () => {
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
    assert.match(response.content[0]?.text ?? "", /outside this root model scope/);
  });

  it("resolves a local agent name and binds fresh internal authority", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });

    await execute(tool, {
      action: "delegate",
      agent: "scout",
      task: "Inspect the workflow API boundary.",
      requirements: ["Return concrete evidence."],
    });

    assert.equal(workflow.delegateCalls.length, 1);
    assert.deepEqual(workflow.delegateCalls[0]?.params, {
      transitionId: "planner.request-scout",
      task: "Inspect the workflow API boundary.",
      requirements: ["Return concrete evidence."],
      workflowRevision: 7,
      authorityDigest: AUTHORITY_DIGEST,
    });
  });

  it("rejects an unavailable local name without delegating", async () => {
    const workflow = new RecordingWorkflow();
    const tool = createWorkflowTool({ workflow });

    const response = await execute(tool, {
      action: "delegate",
      agent: "implementer",
      task: "Do something outside current authority.",
    });

    assert.equal(workflow.delegateCalls.length, 0);
    assert.match(response.content[0]?.text ?? "", /not currently available/);
    assert.deepEqual(response.details?.availableAgents, [
      {
        agent: "scout",
        role: "scout",
        category: "optional",
        modes: ["await"],
      },
    ]);
  });
});
