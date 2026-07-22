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

  it("rejects harness preflight but treats the required root task as a focus hint", () => {
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
      /must describe user work/i,
    );
    assert.equal(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "base",
          task: "Summarize an unrelated deployment guide.",
        }),
      ),
      undefined,
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

  it("allows AGENTS.md prerequisites when the delegation contains concrete QA work", () => {
    const gate = createWorkflowTurnGate();
    gate.beginTurn({
      sessionId,
      turnId,
      userTask: "Do a full QA for this repo.",
      requiredAgents: ["base"],
    });

    assert.equal(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "base",
          task: "Run the canonical deterministic QA gate and all available maintenance-defined checks after reading AGENTS.md.",
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
      authorityResolved: false,
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
      authorityResolved: true,
      currentState: "implementation-ready",
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
      authorityResolved: true,
      currentState: "completed",
      nextRequiredAgents: [],
    });
    assert.equal(gate.authorize(invocation("read")), undefined);

    assert.ok(records.some((record) => record.boundary === "workflow_gate.required"));
    assert.ok(records.some((record) => record.boundary === "workflow_gate.blocked"));
    assert.ok(records.some((record) => record.boundary === "workflow_gate.failed"));
    assert.ok(records.some((record) => record.boundary === "workflow_gate.fulfilled"));
  });

  it("allows lifecycle operations for the active required-delegation handle", () => {
    const gate = createWorkflowTurnGate();
    gate.beginTurn({
      sessionId,
      turnId,
      userTask: "Do a full QA for this repo.",
      requiredAgents: ["base"],
    });

    gate.observe({
      ...invocation("phenix_workflow", {
        action: "spawn",
        agent: "base",
        task: "Run the repository QA review.",
      }),
      isError: false,
      authorityResolved: true,
      currentState: "classified",
      nextRequiredAgents: ["base"],
      handleId: "handle-qa",
      handleStatus: "running",
    });

    assert.equal(
      gate.authorize(invocation("phenix_agent", { action: "poll", id: "handle-qa" })),
      undefined,
    );
    assert.equal(
      gate.authorize(invocation("phenix_agent", { action: "await", id: "handle-qa" })),
      undefined,
    );
    assert.match(
      gate.authorize(invocation("phenix_agent", { action: "poll", id: "other-handle" })) ?? "",
      /handle-qa/i,
    );
    assert.match(gate.authorize(invocation("read", { path: "src/index.ts" })) ?? "", /active/i);

    gate.observe({
      ...invocation("phenix_agent", { action: "await", id: "handle-qa" }),
      isError: false,
      authorityResolved: true,
      currentState: "completed",
      nextRequiredAgents: [],
      handleId: "handle-qa",
      handleStatus: "completed",
    });

    assert.equal(gate.authorize(invocation("read", { path: "src/index.ts" })), undefined);
  });

  it("reconciles a failed workflow node instead of advertising stale agents", () => {
    const records: Record<string, unknown>[] = [];
    const gate = createWorkflowTurnGate({ trace: (record) => records.push({ ...record }) });
    gate.beginTurn({
      sessionId,
      turnId,
      userTask: "Do a full QA pass on this repository.",
      requiredAgents: ["base", "implementer"],
    });

    gate.observe({
      ...invocation("phenix_workflow", {
        action: "spawn",
        agent: "base",
        task: "Perform the full repository QA pass.",
      }),
      isError: true,
      authorityResolved: true,
      currentState: "failed",
      nextRequiredAgents: [],
    });

    assert.match(gate.authorize(invocation("read")) ?? "", /terminal state "failed"/i);
    assert.match(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "base",
          task: "Retry the repository QA pass.",
        }),
      ) ?? "",
      /new user turn may retry/i,
    );
    assert.ok(records.some((record) => record.boundary === "workflow_gate.terminal"));
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

describe("workflow turn gate resumption", () => {
  it("preserves a delegated handle across a resumed parent turn", () => {
    const gate = createWorkflowTurnGate();
    gate.beginTurn({
      sessionId,
      turnId,
      userTask,
      requiredAgents: ["planner"],
    });
    gate.observe({
      ...invocation("phenix_workflow", {
        action: "spawn",
        agent: "planner",
        task: "Plan the repository migration.",
      }),
      isError: false,
      authorityResolved: true,
      nextRequiredAgents: [],
      handleId: "background-handle",
      handleStatus: "running",
    });

    gate.resumeTurn(sessionId, "settlement-turn");
    assert.equal(
      gate.authorize({
        sessionId,
        turnId: "settlement-turn",
        toolName: "phenix_agent",
        input: { action: "await", id: "background-handle" },
      }),
      undefined,
    );
  });
});
