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
import { AGENT_SCOUT } from "../definitions/ids.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { FailureReport, RunId } from "../domain/shared.ts";
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
  readonly reference: AgentSessionReference;
  readonly listeners = new Set<(event: AgentSessionObservation) => void>();
  isStreaming = false;
  disposed = false;

  constructor(id: string) {
    this.reference = { sessionId: id };
  }

  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
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
  readonly sessions: FakeSession[] = [];
  readonly specs: CreateAgentSessionSpec[] = [];

  async create(spec: CreateAgentSessionSpec): Promise<AgentSessionPort> {
    const session = new FakeSession(`fake-${this.sessions.length + 1}`);
    this.sessions.push(session);
    this.specs.push(spec);
    return session;
  }
  async recover(): Promise<AgentSessionPort | undefined> {
    return undefined;
  }
  tool(index: number, name: string): AgentTool {
    const tool = this.specs[index]?.customTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name} for session ${index}`);
    return tool;
  }
}

test("agent failure reports remain inspectable and can be retried with bounded overrides", async () => {
  const ids = new Ids();
  const events = new OrderedDomainEventBus();
  const store = new ExecutionStore({
    ledger: new InMemoryRunLedger(),
    events,
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
    ids,
  });
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const definitions = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions])
    definitions.register(definition);
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
    rootInvokableDefinitions: [AGENT_SCOUT],
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

  const root = "root-graceful-recovery" as RunId;
  await execution.initializeRoot({ id: root, session: { sessionId: "root", cwd: process.cwd() } });
  const first = await execution.start({
    parentId: root,
    definition: definitionRef(AGENT_SCOUT),
    input: { objective: "inspect a difficult repository state" },
    wait: "await",
  });

  for (let index = 0; index < 200; index += 1) {
    backend.sessions[0]?.emit({ type: "tool.started", toolName: "read" });
  }
  await eventually(() => store.projection.toolCallCounts.get(first.id) === 200);
  assert.equal(store.projection.requireRun(first.id).state, "running");
  assert.equal(store.projection.requireRun(first.id).compiled.limits.maxToolCalls, undefined);

  await backend.tool(0, "phenix_fail").execute({
    summary: "Repository lock state prevents further progress.",
    category: "deadlock",
    retryable: true,
    requestedTools: ["bash"],
    suggestedLimits: { timeoutMs: 600_000, maxToolCalls: null },
  });
  const failed = await first.result();
  assert.equal(failed.status, "failure");
  if (failed.status !== "failure") throw new Error("Expected failure");
  assert.equal(failed.failure.code, "agent_reported_failure");
  const report = failed.failure.details as FailureReport;
  assert.equal(report.category, "deadlock");
  assert.deepEqual(report.requestedTools, ["bash"]);

  const retry = await execution.retry(root, first.id, {
    wait: "background",
    addTools: ["bash"],
    limits: { timeoutMs: 600_000, maxTurns: null, maxToolCalls: null },
  });
  const retrySnapshot = await retry.snapshot();
  assert.equal(retrySnapshot.compiled.invocation.retryOf, first.id);
  assert.ok(retrySnapshot.compiled.tools.includes("bash"));
  assert.equal(retrySnapshot.compiled.limits.maxTurns, undefined);
  assert.equal(retrySnapshot.compiled.limits.maxToolCalls, undefined);
  assert.ok(backend.specs[1]?.tools.includes("phenix_fail"));
  assert.ok(backend.specs[1]?.tools.includes("bash"));

  await assert.rejects(
    execution.retry(root, first.id, { addTools: ["edit"] }),
    /may not grant tool edit/,
  );
  await retry.cancel("test complete");
});

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}
