import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import {
  DynamicWorkflowCompileError,
  DynamicWorkflowCompiler,
} from "../application/dynamic-workflow-compiler.ts";
import type { DynamicWorkflowProposal } from "../definitions/dynamic-workflow.ts";
import {
  StockSessionHandoffSchema,
  StockSessionRequestSchema,
} from "../definitions/stock-session.ts";
import type {
  AgentDefinition,
  AnyDefinition,
  InvokeNode,
  ReturnNode,
} from "../domain/definition/definition.ts";
import { defineSchema, type Schema } from "../domain/definition/schema.ts";
import { type DefinitionId, definitionId, runId } from "../domain/shared.ts";
import type { WorkflowEvaluationContext } from "../domain/workflow/graph-state.ts";

const ObjectiveSchema = defineSchema<{ readonly objective: string }>(
  "test.dynamic.objective",
  Type.Object({ objective: Type.String() }),
);
const ScoutRequestSchema = defineSchema<{ readonly objective: string }>(
  "test.dynamic.scout-request",
  Type.Object({ objective: Type.String() }),
);
const ScoutResultSchema = defineSchema<{ readonly summary: string }>(
  "test.dynamic.scout-result",
  Type.Object({ summary: Type.String() }),
);
const FinalRequestSchema = defineSchema<{ readonly evidence: { readonly summary: string } }>(
  "test.dynamic.final-request",
  Type.Object({ evidence: Type.Object({ summary: Type.String() }) }),
);
const FinalResultSchema = defineSchema<{ readonly answer: string }>(
  "test.dynamic.final-result",
  Type.Object({ answer: Type.String() }),
);

const SCOUT = definitionId("agent.test-dynamic-scout");
const FINALIZER = definitionId("agent.test-dynamic-finalizer");
const STOCK = definitionId("session.stock");

function agent(
  id: DefinitionId,
  input: Schema<unknown>,
  output: Schema<unknown>,
  prompt: string,
  sessionMode?: "phenix" | "stock",
): AgentDefinition<unknown, unknown> {
  return {
    id,
    kind: "agent",
    title: id,
    description: `Test definition ${id}`,
    input,
    output,
    ...(sessionMode ? { sessionMode } : {}),
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
    [
      STOCK,
      agent(
        STOCK,
        StockSessionRequestSchema,
        StockSessionHandoffSchema,
        "PHENIX_STOCK_SESSION",
        "stock",
      ),
    ],
  ]);
  const schemas = new Map<string, Schema<unknown>>(
    [
      ObjectiveSchema,
      ScoutRequestSchema,
      ScoutResultSchema,
      FinalRequestSchema,
      FinalResultSchema,
      StockSessionRequestSchema,
      StockSessionHandoffSchema,
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

function stockProposal(): DynamicWorkflowProposal {
  return {
    title: "Stock investigation",
    description: "Bind a concrete typed result to a stock Pi session.",
    inputSchema: ObjectiveSchema.id,
    outputSchema: ScoutResultSchema.id,
    entry: "stock",
    nodes: [
      {
        kind: "invoke",
        id: "stock",
        definitionId: STOCK,
        outputSchema: ScoutResultSchema.id,
        input: {
          source: "object",
          fields: {
            task: { source: "input", path: ["objective"] },
          },
        },
      },
      {
        kind: "return",
        id: "return",
        output: { source: "node", nodeId: "stock" },
      },
    ],
    edges: [{ from: "stock", to: "return" }],
    limits: { timeoutMs: 120_000, maxNodeRuns: 2, maxParallelism: 1 },
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
  assert.deepEqual(Object.keys(first.identity.definitionDigests), [FINALIZER, SCOUT]);

  const scout = first.definition.graph.nodes.find((node) => node.id === "scout") as InvokeNode;
  const finalize = first.definition.graph.nodes.find(
    (node) => node.id === "finalize",
  ) as InvokeNode;
  const returned = first.definition.graph.nodes.find((node) => node.id === "return") as ReturnNode;

  assert.deepEqual(first.mappings.get(scout.input)?.(context()), {
    objective: "Inspect the repository",
  });
  assert.deepEqual(
    first.mappings.get(finalize.input)?.(context(new Map([["scout", { summary: "Evidence" }]]))),
    { evidence: { summary: "Evidence" } },
  );
  assert.deepEqual(
    first.mappings.get(returned.output)?.(context(new Map([["finalize", { answer: "Done" }]]))),
    { answer: "Done" },
  );
});

test("dynamic workflow compiler binds stock session result schemas", () => {
  const compiled = compiler().compile(stockProposal(), { allowedDefinitionIds: [STOCK] });
  const stock = compiled.definition.graph.nodes.find((node) => node.id === "stock");

  assert.equal(stock?.kind, "invoke");
  if (stock?.kind === "invoke") assert.equal(stock.outputSchema, ScoutResultSchema.id);
  assert.ok(compiled.identity.schemaDigests[ScoutResultSchema.id]);

  const missing = stockProposal();
  const missingNodes = missing.nodes.map((node) =>
    node.id === "stock" && node.kind === "invoke" ? { ...node, outputSchema: undefined } : node,
  );
  assert.throws(
    () =>
      compiler().compile({ ...missing, nodes: missingNodes }, { allowedDefinitionIds: [STOCK] }),
    /must declare outputSchema/,
  );

  const override = proposal();
  const overrideNodes = override.nodes.map((node) =>
    node.id === "scout" && node.kind === "invoke"
      ? { ...node, outputSchema: FinalResultSchema.id }
      : node,
  );
  assert.throws(
    () =>
      compiler().compile(
        { ...override, nodes: overrideNodes },
        { allowedDefinitionIds: [SCOUT, FINALIZER] },
      ),
    /may not override fixed output schema/,
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
