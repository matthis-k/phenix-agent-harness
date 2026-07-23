import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRunLedger } from "../adapters/persistence/in-memory-run-ledger.ts";
import { AgentExecutor } from "../application/agent-executor.ts";
import { FacadeAgentToolFactory } from "../application/agent-tools.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { CatalogFacadeImpl } from "../application/catalog-facade.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import { ExecutionFacadeImpl } from "../application/execution-facade.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import { TaskFacadeImpl } from "../application/task-facade.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { AGENT_BASE } from "../definitions/ids.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { RunId } from "../domain/shared.ts";
import type {
  AgentSessionBackend,
  AgentSessionObservation,
  AgentSessionPort,
  AgentSessionReference,
  AgentTool,
  CreateAgentSessionSpec,
} from "../ports/agent-session-backend.ts";
import type { IdGenerator } from "../ports/clock.ts";

class Ids implements IdGenerator {
  private value = 0;
  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${this.value}`;
  }
}

class FakeSession implements AgentSessionPort {
  readonly reference: AgentSessionReference = { sessionId: "fake-child" };
  readonly listeners = new Set<(event: AgentSessionObservation) => void>();
  isStreaming = false;
  followUps = 0;
  disposed = false;

  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {
    this.followUps += 1;
  }
  async notify(): Promise<void> {}
  async abort(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true;
  }
  subscribe(listener: (event: AgentSessionObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: AgentSessionObservation): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeBackend implements AgentSessionBackend {
  readonly session = new FakeSession();
  spec?: CreateAgentSessionSpec;
  async create(spec: CreateAgentSessionSpec): Promise<AgentSessionPort> {
    this.spec = spec;
    return this.session;
  }
  async recover(): Promise<AgentSessionPort | undefined> {
    return undefined;
  }
  tool(name: string): AgentTool {
    const tool = this.spec?.customTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool;
  }
}

test("agent completion requires both typed output and a settled Pi cycle", async () => {
  const ids = new Ids();
  const events = new OrderedDomainEventBus();
  const ledger = new InMemoryRunLedger();
  const store = new ExecutionStore({
    ledger,
    events,
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
    ids,
  });
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const definitions = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions]) {
    definitions.register(definition);
  }
  definitions.seal(functions, {
    has: (operation) => operation === "local.noop" || operation === "local.qa-checks",
    async run(_operation, input) {
      return input;
    },
  });
  const execution = new ExecutionFacadeImpl({
    catalog: definitions,
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
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
  });
  const tasks = new TaskFacadeImpl({
    store,
    catalog: definitions,
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
    ids,
  });
  const catalog = new CatalogFacadeImpl(definitions, store);
  const backend = new FakeBackend();
  const agents = new AgentExecutor({
    backend,
    controller: execution,
    tools: new FacadeAgentToolFactory({ execution, tasks, catalog, store }),
    store,
    cwd: process.cwd(),
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
  });
  execution.registerImplementation("agent", agents);
  execution.registerImplementation("workflow", {
    async start() {
      throw new Error("not used");
    },
  });
  execution.seal();
  const root = "root-agent-lifecycle" as RunId;
  await execution.initializeRoot({ id: root, session: { sessionId: "root", cwd: process.cwd() } });
  const handle = await execution.start({
    parentId: root,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "complete carefully" },
    wait: "await",
  });

  backend.session.emit({ type: "turn.ended" });
  backend.session.emit({ type: "tool.started", toolName: "read" });
  await eventually(
    () =>
      store.projection.turnCounts.get(handle.id) === 1 &&
      store.projection.toolCallCounts.get(handle.id) === 1,
  );

  backend.session.emit({ type: "cycle.settled" });
  await eventually(() => backend.session.followUps === 1);
  assert.equal(store.projection.requireRun(handle.id).state, "running");

  await backend.tool("phenix_return").execute({
    summary: "done",
    artifacts: [],
    unresolved: [],
  });
  assert.equal(store.projection.requireRun(handle.id).state, "completing");

  backend.session.emit({ type: "cycle.settled" });
  const outcome = await handle.result();
  assert.equal(outcome.status, "success");
  await eventually(() => backend.session.disposed);

  const recovered = new ExecutionStore({
    ledger,
    events: new OrderedDomainEventBus(),
    clock: { now: () => "2026-01-01T00:00:01.000Z" },
    ids: new Ids(),
  });
  await recovered.load(root);
  assert.equal(recovered.projection.turnCounts.get(handle.id), 1);
  assert.equal(recovered.projection.toolCallCounts.get(handle.id), 1);
});

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}
