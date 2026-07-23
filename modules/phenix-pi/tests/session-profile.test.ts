import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRunLedger } from "../adapters/persistence/in-memory-run-ledger.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import { ExecutionFacadeImpl } from "../application/execution-facade.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import { SessionProfileFacadeImpl } from "../application/session-profile-facade.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import type { RunId } from "../domain/shared.ts";
import type { IdGenerator } from "../ports/clock.ts";

class Ids implements IdGenerator {
  private value = 0;
  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${this.value}`;
  }
}

function catalog() {
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const definitions = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions])
    definitions.register(definition);
  definitions.seal(functions, {
    has: (operation) => operation === "local.noop" || operation === "local.qa-checks",
    async run() {
      return undefined;
    },
  });
  return definitions;
}

test("session profile changes are event-sourced and survive recovery", async () => {
  const root = "root-profile" as RunId;
  const ledger = new InMemoryRunLedger();
  const ids = new Ids();
  const events = new OrderedDomainEventBus();
  const store = new ExecutionStore({
    ledger,
    events,
    ids,
    clock: { now: () => "2026-07-23T00:00:00.000Z" },
  });
  const execution = new ExecutionFacadeImpl({
    catalog: catalog(),
    store,
    models: {
      async resolve(selector) {
        return {
          requested: selector,
          concrete: { kind: "concrete", provider: "test", model: "model" },
          thinking: "medium",
          policyRevision: "test",
        };
      },
    },
    ids,
    clock: { now: () => "2026-07-23T00:00:00.000Z" },
  });
  execution.registerImplementation("agent", { async start() {} });
  execution.registerImplementation("workflow", { async start() {} });
  execution.seal();
  await execution.initializeRoot({
    id: root,
    session: { sessionId: "pi-root", cwd: process.cwd() },
  });

  const profiles = new SessionProfileFacadeImpl(store);
  assert.deepEqual(await profiles.current(root), {
    agent: "base",
    modelSet: "mixed",
    difficulty: "D1",
  });
  const selected = await profiles.select(root, {
    agent: "architect",
    modelSet: "chatgpt-plus",
    difficulty: "D3",
    source: "user",
  });
  assert.deepEqual(selected, {
    agent: "architect",
    modelSet: "chatgpt-plus",
    difficulty: "D3",
  });
  assert.equal(
    store.projection.events.filter((event) => event.type === "run.profile.selected").length,
    1,
  );

  const recovered = new ExecutionStore({
    ledger,
    events: new OrderedDomainEventBus(),
    ids: new Ids(),
    clock: { now: () => "2026-07-23T00:00:01.000Z" },
  });
  await recovered.load(root);
  assert.deepEqual(recovered.projection.requireRun(root).profile, selected);
});
