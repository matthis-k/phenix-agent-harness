import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import {
  DynamicWorkflowCompileError,
  DynamicWorkflowCompiler,
} from "../application/dynamic-workflow-compiler.ts";
import type { DynamicWorkflowProposal } from "../definitions/dynamic-workflow.ts";
import type { AgentDefinition, AnyDefinition, InvokeNode, ReturnNode } from "../domain/definition/definition.ts";
import { defineSchema, type Schema } from "../domain/definition/schema.ts";
import { definitionId, runId, type DefinitionId } from "../domain/shared.ts";
import type { WorkflowEvaluationContext } from "../domain/workflow/graph-state.ts";

const ObjectiveSchema = defineSchema<{ readonly objective: string }>(
  "test.dynamic.objective.v1",
  Type.Object({ objective: Type.String() }),
);
const ScoutRequestSchema = defineSchema<{ readonly objective: string }>(
  "test.dynamic.scout-request.v1",
  Type.Object({ objective: Type.String() }),
);
const ScoutResultSchema = defineSchema<{ readonly summary: string }>(
  "test.dynamic.scout-result.v1",
  Type.Object({ summary: Type.String() }),
);
const FinalRequestSchema = defineSchema<{ readonly evidence: { readonly summary: string } }>(
  "test.dynamic.final-request.v1",
  Type.Object({ evidence: Type.Object({ summary: Type.String() }) }),
);
const FinalResultSchema = defineSchema<{ readonly answer: string }>(
  "test.dynamic.final-result.v1",
  Type.Object({ answer: Type.String() }),
);

const SCOUT = definitionId("agent.test-dynamic-scout");
const FINALIZER = definitionId("agent.test-dynamic-finalizer");

function agent(
  id: DefinitionId,
  input: Schema<unknown>,
  output: Schema<unknown>,
  prompt: string,
): AgentDefinition<unknown, unknown> {
  return {
    id,
    kind: "agent",
    title: id,
    description: `Test definition ${id}`,
    input,
    output,
    model: { kind: "session" },
    thinking: "route",
    prompt: { render: () => prompt },
    tools: { allow: [] },
    context: {
      projectFiles: "none",
      parentConversation: "none",
      artifacts: [],
      maxBytes: 0,
    },
    childCapabilities: {
      invokableDefinitions: [],
      maxDepth: 0,
      mayDetach: false,
      maySend: false,
      mayCancelChildren: false,
    },
    limits: { timeoutMs: 60_000, maxRepairAttempts: 1 },
    persistence: "memory",
  };
}

function compiler(prompt = "Finalize the evidence"): DynamicWorkflowCompiler {
  const definitions = new Map<string, AnyDefinition>([
    [SCOUT, agent(SCOUT, ScoutRequestSchema, ScoutResultSchema, "Gather evidence")],
    [FINALIZER, agent(FINALIZER, FinalRequestSchema, FinalResultSchema, prompt)],
  ]);
  const schemas = new Map<string, Schema<unknown>>(
    [
      ObjectiveSchema,
      ScoutRequestSchema,
      ScoutResultSchema,
      FinalRequestSchema,
      FinalResultSchema,
    ].map((schema) => [schema.id, schema as Schema<unknown>]),
  );
  return new DynamicWorkflowCompiler({
    resolveDefinition(id) {
      const definition = definitions.get(id);
      if (!definition) throw new Error(`Unknown test definition ${id}`);
      return definition;
    },
    resolveSchema(id) {
      const schema = schemas.get(id);
      if (!schema) throw new Error(`Unknown test schema ${id}`);
      return schema;
    },
  });
}

function proposal(): DynamicWorkflowProposal {
  return {
    title: "Investigate and answer",
    description: "Compose two typed building blocks without executable workflow source.",
    inputSchema: ObjectiveSchema.id,
    outputSchema: FinalResultSchema.id,
    entry: "scout",
    nodes: [
      {
        kind: "invoke",
        id: "scout",
        definitionId: SCOUT,
        input: {
          source: "object",
          fields: {
            objective: { source: "input", path: ["objective"] },
          },
        },
      },
      {
        kind: "invoke",
        id: "finalize",
        definitionId: FINALIZER,
        input: {
          source: "object",
          fields: {
            evidence: { source: "node", nodeId: "scout" },
          },
        },
      },
      {
        kind: "return",
        id: "return",
        output: { source: "node", nodeId: "finalize" },
      },
    ],
    edges: [
      { from: "scout", to: "finalize" },
      { from: "finalize", to: "return" },
    ],
    limits: {
      timeoutMs: 300_000,
      maxNodeRuns: 3,
      maxParallelism: 1,
    },
  };
}

function context(latest: ReadonlyMap<string, unknown> = new Map()): WorkflowEvaluationContext {
  return {
    runId: runId("run-dynamic-test"),
    input: { objective: "Inspect the repository" },
    results: new Map(),
    latest,
    childOutcomes: new Map(),
    transitionCounts: new Map(),
  };
}

test("dynamic workflow compiler seals deterministic typed graphs", () => {
  const first = compiler().compile(proposal(), {
    allowedDefinitionIds: [SCOUT, FINALIZER],
  });
  const second = compiler().compile(proposal(), {
    allowedDefinitionIds: [SCOUT, FINALIZER],
  });

  assert.equal(first.identity.graphDigest, second.identity.graphDigest);
  assert.equal(first.definition.id, second.definition.id);
  assert.match(first.definition.id, /^workflow\.dynamic\.[a-f0-9]{24}$/);
  assert.ok(Object.isFrozen(first.definition));
  assert.deepEqual(Object.keys(first.identity.definitionDigests), [SCOUT, FINALIZER]);

  const scout = first.definition.graph.nodes.find((node) => node.id === "scout") as InvokeNode;
  const finalize = first.definition.graph.nodes.find((node) => node.id === "finalize") as InvokeNode;
  const returned = first.definition.graph.nodes.find((node) => node.id === "return") as ReturnNode;

  assert.deepEqual(first.mappings.get(scout.input)?.(context()), {
    objective: "Inspect the repository",
  });
  assert.deepEqual(
    first.mappings.get(finalize.input)?.(
      context(new Map([["scout", { summary: "Evidence" }]])),
    ),
    { evidence: { summary: "Evidence" } },
  );
  assert.deepEqual(
    first.mappings.get(returned.output)?.(
      context(new Map([["finalize", { answer: "Done" }]])),
    ),
    { answer: "Done" },
  );
});

test("dynamic workflow compiler rejects definitions outside the capability-filtered catalog", () => {
  assert.throws(
    () => compiler().compile(proposal(), { allowedDefinitionIds: [SCOUT] }),
    (error: unknown) =>
      error instanceof DynamicWorkflowCompileError && /unavailable definition/.test(error.message),
  );
});

test("dynamic workflow compiler rejects non-upstream result bindings", () => {
  const invalid = proposal();
  const nodes = invalid.nodes.map((node) =>
    node.id === "scout" && node.kind === "invoke"
      ? { ...node, input: { source: "node" as const, nodeId: "finalize" } }
      : node,
  );
  assert.throws(
    () => compiler().compile({ ...invalid, nodes }, { allowedDefinitionIds: [SCOUT, FINALIZER] }),
    (error: unknown) =>
      error instanceof DynamicWorkflowCompileError && /not upstream/.test(error.message),
  );
});

test("dynamic workflow identity reports referenced-definition drift", () => {
  const before = compiler("Finalize the evidence").compile(proposal(), {
    allowedDefinitionIds: [SCOUT, FINALIZER],
  });
  const after = compiler("Finalize the evidence conservatively").compile(proposal(), {
    allowedDefinitionIds: [SCOUT, FINALIZER],
  });

  assert.notEqual(
    before.identity.definitionDigests[FINALIZER],
    after.identity.definitionDigests[FINALIZER],
  );
  assert.notEqual(before.identity.graphDigest, after.identity.graphDigest);
});
