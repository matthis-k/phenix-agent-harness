import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWorkflowTurnGate } from "@matthis-k/phenix-suite/composition/workflow-turn-gate.ts";

const sessionId = "session-test";
const turnId = "turn-test";
const userTask = "Plan and verify the full repository migration.";

function invocation(toolName: string, input: Record<string, unknown> = {}) {
  return { sessionId, turnId, toolName, input };
}

describe("workflow turn gate", () => {
  it("allows local skill preflight but blocks unrelated execution", () => {
    const records: Record<string, unknown>[] = [];
    const gate = createWorkflowTurnGate({ trace: (record) => records.push({ ...record }) });

    gate.beginTurn({
      sessionId,
      turnId,
      userTask,
      requiredAgents: ["planner"],
    });

    assert.equal(
      gate.authorize(
        invocation("read", {
          path: "/nix/store/example-phenix-pi/skills/phenix-qa/SKILL.md",
        }),
      ),
      undefined,
    );
    assert.match(
      gate.authorize(invocation("read", { path: "src/index.ts" })) ?? "",
      /requires delegation before read/i,
    );
    assert.ok(records.some((record) => record.boundary === "workflow_gate.preflight"));
  });

  it("rejects harness preflight and unrelated tasks as required delegation", () => {
    const gate = createWorkflowTurnGate();
    gate.beginTurn({
      sessionId,
      turnId,
      userTask: "Do a full QA for this repo.",
      requiredAgents: ["base", "implementer"],
    });

    assert.match(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "base",
          task: "Read the phenix-qa skill file from /nix/store/example/skills/phenix-qa/SKILL.md",
        }),
      ) ?? "",
      /bounded part of the user's request/i,
    );
    assert.match(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "base",
          task: "Summarize an unrelated deployment guide.",
        }),
      ) ?? "",
      /bounded part of the user's request/i,
    );
    assert.equal(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "base",
          task: "Perform a full QA review of the current repository and report findings.",
        }),
      ),
      undefined,
    );
  });

  it("blocks non-workflow tools until a required spawn succeeds", () => {
    const records: Record<string, unknown>[] = [];
    const gate = createWorkflowTurnGate({ trace: (record) => records.push({ ...record }) });

    gate.beginTurn({
      sessionId,
      turnId,
      userTask,
      requiredAgents: ["planner", "planner"],
    });

    assert.match(gate.authorize(invocation("read")) ?? "", /requires delegation before read/i);
    assert.match(
      gate.authorize(invocation("phenix_workflow", { action: "inspect" })) ?? "",
      /requires action=spawn/i,
    );
    assert.match(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "scout",
          task: "Inspect the repository migration.",
        }),
      ) ?? "",
      /not a currently required target/i,
    );
    assert.equal(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "planner",
          task: "Plan the full repository migration.",
        }),
      ),
      undefined,
    );

    gate.observe({
      ...invocation("phenix_workflow", {
        action: "spawn",
        agent: "planner",
        task: "Plan the full repository migration.",
      }),
      isError: true,
      nextRequiredAgents: [],
    });
    assert.match(gate.authorize(invocation("read")) ?? "", /requires delegation before read/i);

    gate.observe({
      ...invocation("phenix_workflow", {
        action: "spawn",
        agent: "planner",
        task: "Plan the full repository migration.",
      }),
      isError: false,
      nextRequiredAgents: ["tester"],
    });
    assert.match(gate.authorize(invocation("read")) ?? "", /tester/i);
    assert.equal(
      gate.authorize(
        invocation("phenix_workflow", { action: "spawn", agent: "tester", task: "Test" }),
      ),
      undefined,
    );

    gate.observe({
      ...invocation("phenix_workflow", { action: "spawn", agent: "tester", task: "Test" }),
      isError: false,
      nextRequiredAgents: [],
    });
    assert.equal(gate.authorize(invocation("read")), undefined);

    assert.ok(records.some((record) => record.boundary === "workflow_gate.required"));
    assert.ok(records.some((record) => record.boundary === "workflow_gate.blocked"));
    assert.ok(records.some((record) => record.boundary === "workflow_gate.failed"));
    assert.ok(records.some((record) => record.boundary === "workflow_gate.fulfilled"));
  });

  it("leaves direct execution open when authority has no required transition", () => {
    const gate = createWorkflowTurnGate();
    gate.beginTurn({ sessionId, turnId, userTask, requiredAgents: [] });
    assert.equal(gate.authorize(invocation("read")), undefined);
  });

  it("does not leak a prior turn requirement into a new turn", () => {
    const gate = createWorkflowTurnGate();
    gate.beginTurn({ sessionId, turnId, userTask, requiredAgents: ["planner"] });
    assert.equal(
      gate.authorize({ sessionId, turnId: "turn-new", toolName: "read", input: {} }),
      undefined,
    );
  });
});
