import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWorkflowTurnGate } from "@matthis-k/phenix-suite/composition/workflow-turn-gate.ts";

const sessionId = "session-test";
const turnId = "turn-test";

function invocation(toolName: string, input: Record<string, unknown> = {}) {
  return { sessionId, turnId, toolName, input };
}

describe("workflow turn gate", () => {
  it("blocks non-workflow tools until a required spawn succeeds", () => {
    const records: Record<string, unknown>[] = [];
    const gate = createWorkflowTurnGate({ trace: (record) => records.push({ ...record }) });

    gate.beginTurn({ sessionId, turnId, requiredAgents: ["planner", "planner"] });

    assert.match(gate.authorize(invocation("read")) ?? "", /requires delegation before read/i);
    assert.match(
      gate.authorize(invocation("phenix_workflow", { action: "inspect" })) ?? "",
      /requires action=spawn/i,
    );
    assert.match(
      gate.authorize(
        invocation("phenix_workflow", { action: "spawn", agent: "scout", task: "Inspect" }),
      ) ?? "",
      /not a currently required target/i,
    );
    assert.equal(
      gate.authorize(
        invocation("phenix_workflow", { action: "spawn", agent: "planner", task: "Plan" }),
      ),
      undefined,
    );

    gate.observe({
      ...invocation("phenix_workflow", { action: "spawn", agent: "planner", task: "Plan" }),
      isError: true,
      nextRequiredAgents: [],
    });
    assert.match(gate.authorize(invocation("read")) ?? "", /requires delegation before read/i);

    gate.observe({
      ...invocation("phenix_workflow", { action: "spawn", agent: "planner", task: "Plan" }),
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
    gate.beginTurn({ sessionId, turnId, requiredAgents: [] });
    assert.equal(gate.authorize(invocation("read")), undefined);
  });

  it("does not leak a prior turn requirement into a new turn", () => {
    const gate = createWorkflowTurnGate();
    gate.beginTurn({ sessionId, turnId, requiredAgents: ["planner"] });
    assert.equal(
      gate.authorize({ sessionId, turnId: "turn-new", toolName: "read", input: {} }),
      undefined,
    );
  });
});
