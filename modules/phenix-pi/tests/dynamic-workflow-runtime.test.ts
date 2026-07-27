import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { DynamicWorkflowCompiler } from "../application/dynamic-workflow-compiler.ts";
import {
  DynamicWorkflowDriftError,
  DynamicWorkflowRuntimeRegistry,
} from "../application/dynamic-workflow-runtime.ts";
import type { DynamicWorkflowProposal } from "../definitions/dynamic-workflow.ts";
import type { AgentDefinition } from "../domain/definition/definition.ts";
import { defineSchema, type Schema } from "../domain/definition/schema.ts";
import { type DefinitionId, definitionId } from "../domain/shared.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";

const RequestSchema = defineSchema<{ readonly objective: string }>(
  "test.dynamic-runtime.request",
  Type.Object({ objective: Type.String() }),
);
const ResultSchema = defineSchema<{ readonly summary: string }>(
  "test.dynamic-runtime.result",
  Type.Object({ summary: Type.String() }),
);
const SCOUT = definitionId("agent.test-dynamic-runtime-scout");

function agent(prompt: string): AgentDefinition<unknown, unknown> {
  return {
    id: SCOUT,
    kind: "agent",
    title: "Runtime scout",
    description: "Test dynamic runtime building block.",
    input: RequestSchema as Schema<unknown>,
    output: ResultSchema as Schema<unknown>,
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

function proposal(): DynamicWorkflowProposal {
  return {
    title: "Dynamic runtime test",
    description: "Invoke one statically authorized building block.",
    inputSchema: RequestSchema.id,
    outputSchema: ResultSchema.id,
    entry: "scout",
    nodes: [
      {
        kind: "invoke",
        id: "scout",
        definitionId: SCOUT,
        input: { source: "input" },
      },
      {
        kind: "return",
        id: "return",
        output: { source: "node", nodeId: "scout" },
      },
    ],
    edges: [{ from: "scout", to: "return" }],
    limits: {
      timeoutMs: 120_000,
      maxNodeRuns: 2,
      maxParallelism: 1,
    },
  };
}

function runtime(prompt = "Gather evidence"): {
  readonly catalog: DefinitionCatalog;
  readonly functions: WorkflowFunctionRegistry;
  readonly registry: DynamicWorkflowRuntimeRegistry;
} {
  const catalog = new DefinitionCatalog();
  const functions = new WorkflowFunctionRegistry();
  catalog.register(agent(prompt));
  catalog.seal(functions, noOperations);
  const schemas = new Map<string, Schema<unknown>>([
    [RequestSchema.id, RequestSchema as Schema<unknown>],
    [ResultSchema.id, ResultSchema as Schema<unknown>],
  ]);
  const compiler = new DynamicWorkflowCompiler({
    resolveDefinition: (id) => catalog.require(id),
    resolveSchema(id) {
      const schema = schemas.get(id);
      if (!schema) throw new Error(`Unknown test schema ${id}`);
      return schema;
    },
  });
  return {
    catalog,
    functions,
    registry: new DynamicWorkflowRuntimeRegistry({ compiler, catalog, functions }),
  };
}

const noOperations: LocalOperationRunner = {
  has: () => false,
  run: async (operation) => {
    throw new Error(`Unexpected local operation ${operation}`);
  },
};

test("runtime dynamic workflows remain hidden from the static catalog surface", () => {
  const { catalog, functions, registry } = runtime();
  const compiled = registry.compile(proposal(), [SCOUT]);

  assert.equal(catalog.list().length, 1);
  assert.equal(catalog.require(compiled.definition.id), compiled.definition);
  for (const ref of compiled.mappings.keys()) {
    assert.equal(functions.hasMapping(ref), true);
  }
  assert.deepEqual(registry.identity(compiled.definition.id), compiled.identity);
});

test("runtime dynamic workflow snapshots restore the identical sealed contract", () => {
  const original = runtime();
  const compiled = original.registry.compile(proposal(), [SCOUT]);
  const snapshot = original.registry.install(compiled);

  const restored = runtime().registry.restore(snapshot);
  assert.equal(restored.definition.id, compiled.definition.id);
  assert.equal(restored.identity.graphDigest, compiled.identity.graphDigest);
});

test("runtime restoration rejects referenced-definition drift", () => {
  const original = runtime("Gather evidence");
  const snapshot = original.registry.install(original.registry.compile(proposal(), [SCOUT]));
  const changed = runtime("Gather evidence conservatively");

  assert.throws(
    () => changed.registry.restore(snapshot),
    (error: unknown) => error instanceof DynamicWorkflowDriftError,
  );
});

test("runtime compilation enforces the caller supplied definition scope", () => {
  const { registry } = runtime();
  assert.throws(
    () => registry.compile(proposal(), [] as readonly DefinitionId[]),
    /unavailable definition/,
  );
});
