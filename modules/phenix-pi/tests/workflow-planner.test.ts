import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTransitionOutcome,
} from "../domain/definition/definition.ts";
import type { Schema } from "../domain/definition/schema.ts";
import type { RunRecord } from "../domain/run/model.ts";
import { definitionId, failed, runId, success } from "../domain/shared.ts";
import type { WorkflowGraphState } from "../domain/workflow/graph-state.ts";
import { planWorkflowStep } from "../domain/workflow/planner.ts";

const schema: Schema<unknown> = {
  id: "test.value",
  jsonSchema: {} as Schema<unknown>["jsonSchema"],
  validate: (value: unknown) => ({ ok: true, value }),
};

function definition(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  entry = nodes[0]?.id ?? "missing",
  maxParallelism = 2,
): WorkflowDefinition<unknown, unknown> {
  return {
    id: definitionId("workflow.test"),
    kind: "workflow",
    title: "Test",
    description: "Test",
    input: schema,
    output: schema,
    graph: { entry, nodes, edges },
    limits: { timeoutMs: 1_000, maxNodeRuns: 20, maxParallelism },
  };
}

function state(
  workflow: WorkflowDefinition<unknown, unknown>,
  active: readonly { id: string; nodeId: string; sequence: number }[],
  input: {
    readonly results?: ReadonlyMap<string, readonly unknown[]>;
    readonly transitions?: ReadonlyMap<string, number>;
    readonly nodeRuns?: number;
  } = {},
): WorkflowGraphState {
  const results = input.results ?? new Map();
  return {
    definition: workflow,
    active: active.map((item) => ({
      activationId: item.id,
      nodeId: item.nodeId,
      enteredSequence: item.sequence,
      completed: false,
    })),
    activations: new Map(),
    context: {
      runId: runId("run-workflow"),
      input: {},
      results,
      latest: new Map(
        [...results].flatMap(([nodeId, values]) =>
          values.length === 0 ? [] : [[nodeId, values.at(-1)] as const],
        ),
      ),
      childOutcomes: new Map(),
      transitionCounts: input.transitions ?? new Map(),
    },
    nodeRuns: input.nodeRuns ?? active.length,
  };
}

function child(input: {
  readonly id: string;
  readonly nodeId: string;
  readonly activationId: string;
  readonly state: RunRecord["state"];
  readonly outcome?: RunRecord["outcome"];
  readonly retryOf?: string;
  readonly requestedAt?: string;
}): RunRecord {
  return {
    id: runId(input.id),
    parentId: runId("run-workflow"),
    kind: "agent",
    definitionId: definitionId("agent.test"),
    input: {},
    outputSchemaId: "test.value",
    requestedAt: input.requestedAt ?? "2026-08-01T00:00:00.000Z",
    ownership: "attached",
    state: input.state,
    revision: 1,
    compiled: {
      definitionId: definitionId("agent.test"),
      input: {},
      outputSchemaId: "test.value",
      tools: [],
      limits: { timeoutMs: 1_000 },
      capabilities: {
        invokableDefinitions: [],
        maxDepth: 0,
        mayDetach: false,
        maySend: false,
        mayCancelChildren: false,
      },
      invocation: {
        wait: "await",
        causation: {
          workflowRunId: runId("run-workflow"),
          nodeId: input.nodeId,
          activationId: input.activationId,
        },
        ...(input.retryOf ? { retryOf: runId(input.retryOf) } : {}),
      },
    },
    ...(input.outcome ? { outcome: input.outcome } : {}),
  };
}

function plan(
  workflowState: WorkflowGraphState,
  children: readonly RunRecord[] = [],
  activeAttachedChildren = 0,
) {
  return planWorkflowStep({
    state: workflowState,
    children,
    activeAttachedChildren,
    selectEdges: (current, node, _result, outcome) =>
      current.definition.graph.edges.filter(
        (edge) => edge.from === node.id && matches(edge, outcome),
      ),
  });
}

function matches(edge: WorkflowEdge, outcome: WorkflowTransitionOutcome): boolean {
  const accepted = edge.on ?? "success";
  return accepted === "any" || accepted === outcome;
}

test("scheduler skips blocked activations but preserves deterministic entry order", () => {
  const workflow = definition(
    [
      {
        kind: "invoke",
        id: "slow",
        definition: { id: definitionId("agent.test") },
        input: "mapping.input",
        wait: "await",
      },
      { kind: "decision", id: "ready", decide: "decision.ready" },
    ],
    [],
  );
  const slow = child({
    id: "run-slow",
    nodeId: "slow",
    activationId: "activation-slow",
    state: "running",
  });

  const result = plan(
    state(workflow, [
      { id: "activation-ready", nodeId: "ready", sequence: 2 },
      { id: "activation-slow", nodeId: "slow", sequence: 1 },
    ]),
    [slow],
    1,
  );

  assert.equal(result.kind, "evaluate-decision");
  if (result.kind === "evaluate-decision") {
    assert.equal(result.activationId, "activation-ready");
  }
});

test("retry policy produces a linked replacement action before consuming failure edges", () => {
  const workflow = definition(
    [
      {
        kind: "invoke",
        id: "review",
        definition: { id: definitionId("agent.test") },
        input: "mapping.input",
        wait: "await",
        retry: { when: "retryable", maxRetries: 1 },
      },
      { kind: "return", id: "done", output: "mapping.output" },
    ],
    [{ from: "review", to: "done", on: "failure" }],
  );
  const first = child({
    id: "run-first",
    nodeId: "review",
    activationId: "activation-review",
    state: "failed",
    outcome: failed({ code: "provider_failed", message: "transient", retryable: true }),
  });

  const result = plan(
    state(workflow, [{ id: "activation-review", nodeId: "review", sequence: 1 }]),
    [first],
  );

  assert.equal(result.kind, "retry-child");
  if (result.kind === "retry-child") assert.equal(result.child.id, first.id);
});

test("exhausted retry completes through the declared failure transition", () => {
  const workflow = definition(
    [
      {
        kind: "invoke",
        id: "review",
        definition: { id: definitionId("agent.test") },
        input: "mapping.input",
        wait: "await",
        retry: { when: "retryable", maxRetries: 1 },
      },
      { kind: "return", id: "done", output: "mapping.output" },
    ],
    [{ from: "review", to: "done", on: "failure" }],
  );
  const first = child({
    id: "run-first",
    nodeId: "review",
    activationId: "activation-review",
    state: "failed",
    outcome: failed({ code: "provider_failed", message: "first", retryable: true }),
  });
  const replacement = child({
    id: "run-replacement",
    nodeId: "review",
    activationId: "activation-review",
    state: "failed",
    retryOf: "run-first",
    outcome: failed({ code: "provider_failed", message: "second", retryable: true }),
  });

  const result = plan(
    state(workflow, [{ id: "activation-review", nodeId: "review", sequence: 1 }]),
    [first, replacement],
  );

  assert.equal(result.kind, "complete-invoke");
  if (result.kind === "complete-invoke") assert.equal(result.child.id, replacement.id);
});

test("retry-chain causation selects the replacement even when IDs do not sort by creation", () => {
  const workflow = definition(
    [
      {
        kind: "invoke",
        id: "review",
        definition: { id: definitionId("agent.test") },
        input: "mapping.input",
        wait: "await",
        retry: { when: "retryable", maxRetries: 1 },
      },
      { kind: "return", id: "done", output: "mapping.output" },
    ],
    [{ from: "review", to: "done", on: "failure" }],
  );
  const original = child({
    id: "run-z-original",
    nodeId: "review",
    activationId: "activation-review",
    state: "failed",
    outcome: failed({ code: "provider_failed", message: "first", retryable: true }),
  });
  const replacement = child({
    id: "run-a-replacement",
    nodeId: "review",
    activationId: "activation-review",
    state: "completed",
    retryOf: "run-z-original",
    outcome: success("accepted"),
  });

  const result = plan(
    state(workflow, [{ id: "activation-review", nodeId: "review", sequence: 1 }]),
    [replacement, original],
  );

  assert.equal(result.kind, "complete-invoke");
  if (result.kind === "complete-invoke") assert.equal(result.child.id, replacement.id);
});

test("join completion is derived only from durable transition and result projections", () => {
  const workflow = definition(
    [
      {
        kind: "invoke",
        id: "left",
        definition: { id: definitionId("agent.test") },
        input: "mapping.left",
        wait: "await",
      },
      {
        kind: "invoke",
        id: "right",
        definition: { id: definitionId("agent.test") },
        input: "mapping.right",
        wait: "await",
      },
      { kind: "join", id: "join", policy: "all-success" },
    ],
    [
      { from: "left", to: "join" },
      { from: "right", to: "join" },
    ],
  );
  const results = new Map<string, readonly unknown[]>([
    ["left", [success("left")]],
    ["right", [success("right")]],
  ]);
  const transitions = new Map([
    ["left->join", 1],
    ["right->join", 1],
  ]);

  const result = plan(
    state(workflow, [{ id: "activation-join", nodeId: "join", sequence: 3 }], {
      results,
      transitions,
    }),
  );

  assert.equal(result.kind, "complete-join");
  if (result.kind === "complete-join") {
    assert.deepEqual(result.result, {
      left: [success("left")],
      right: [success("right")],
    });
  }
});

test("strict joins classify a required branch failure as workflow rejection", () => {
  const workflow = definition(
    [
      {
        kind: "invoke",
        id: "left",
        definition: { id: definitionId("agent.test") },
        input: "mapping.left",
        wait: "await",
      },
      {
        kind: "invoke",
        id: "right",
        definition: { id: definitionId("agent.test") },
        input: "mapping.right",
        wait: "await",
      },
      { kind: "join", id: "join", policy: "all-success" },
    ],
    [
      { from: "left", to: "join" },
      { from: "right", to: "join" },
    ],
  );
  const results = new Map<string, readonly unknown[]>([
    [
      "left",
      [failed({ code: "agent_reported_failure", message: "rejected", retryable: false })],
    ],
  ]);
  const transitions = new Map([["left->join", 1]]);

  const result = plan(
    state(workflow, [{ id: "activation-join", nodeId: "join", sequence: 3 }], {
      results,
      transitions,
    }),
  );

  assert.equal(result.kind, "fail-workflow");
  if (result.kind === "fail-workflow") {
    assert.equal(result.failure.code, "workflow_rejected");
    assert.match(result.failure.message, /failed required branch/);
  }
});

test("parallelism pressure becomes an explicit wait plan", () => {
  const workflow = definition(
    [
      {
        kind: "invoke",
        id: "next",
        definition: { id: definitionId("agent.test") },
        input: "mapping.input",
        wait: "await",
      },
    ],
    [],
    "next",
    1,
  );

  const result = plan(
    state(workflow, [{ id: "activation-next", nodeId: "next", sequence: 1 }]),
    [],
    1,
  );

  assert.equal(result.kind, "wait");
  if (result.kind === "wait") {
    assert.deepEqual(result.blocked, [
      {
        activationId: "activation-next",
        nodeId: "next",
        reason: "parallelism-limit",
      },
    ]);
  }
});

test("node-run exhaustion is decided before any additional effect", () => {
  const workflow = definition([{ kind: "decision", id: "next", decide: "decision.next" }], []);
  const result = plan(
    state(workflow, [{ id: "activation-next", nodeId: "next", sequence: 1 }], {
      nodeRuns: workflow.limits.maxNodeRuns + 1,
    }),
  );

  assert.equal(result.kind, "fail-workflow");
  if (result.kind === "fail-workflow") {
    assert.equal(result.failure.code, "workflow_exhausted");
  }
});

test("an unhandled terminal child failure becomes the workflow failure", () => {
  const workflow = definition(
    [
      {
        kind: "invoke",
        id: "worker",
        definition: { id: definitionId("agent.test") },
        input: "mapping.input",
        wait: "await",
      },
    ],
    [],
  );
  const failedChild = child({
    id: "run-failed",
    nodeId: "worker",
    activationId: "activation-worker",
    state: "failed",
    outcome: failed({ code: "provider_failed", message: "provider unavailable", retryable: true }),
  });

  const result = plan(
    state(workflow, [{ id: "activation-worker", nodeId: "worker", sequence: 1 }]),
    [failedChild],
  );

  assert.equal(result.kind, "fail-workflow");
  if (result.kind === "fail-workflow") {
    assert.equal(result.failure.code, "provider_failed");
    assert.equal(result.failure.retryable, false);
    assert.equal(result.failure.causeRunId, failedChild.id);
  }
});
