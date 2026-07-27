import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRunLedger } from "../adapters/persistence/in-memory-run-ledger.ts";
import { AgentExecutor } from "../application/agent-executor.ts";
import { FacadeAgentToolFactory } from "../application/agent-tools.ts";
import {
  encodeBudgetResumeControl,
  pendingBudgetSuspension,
} from "../application/budget-suspension.ts";
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
import type { RunRetryLimitOverrides } from "../domain/run/model.ts";
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
  readonly reference: AgentSessionReference = { sessionId: "same-budget-session" };
  readonly listeners = new Set<(event: AgentSessionObservation) => void>();
  isStreaming = false;
  followUps: string[] = [];
  disposed = false;

  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async followUp(message: string): Promise<void> {
    this.followUps.push(message);
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
}

class FakeBackend implements AgentSessionBackend {
  readonly session = new FakeSession();
  createCalls = 0;
  spec?: CreateAgentSessionSpec;

  async create(spec: CreateAgentSessionSpec): Promise<AgentSessionPort> {
    this.createCalls += 1;
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

test("resource-limit reports suspend and resume the original child session", async () => {
  const ids = new Ids();
  const store = new ExecutionStore({
    ledger: new InMemoryRunLedger(),
    events: new OrderedDomainEventBus(),
    clock: { now: () => "2026-07-25T00:00:00.000Z" },
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
        };
      },
    },
    ids,
    clock: { now: () => "2026-07-25T00:00:00.000Z" },
  });
  const tasks = new TaskFacadeImpl({
    store,
    catalog: definitions,
    clock: { now: () => "2026-07-25T00:00:00.000Z" },
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
    clock: { now: () => "2026-07-25T00:00:00.000Z" },
  });
  execution.registerImplementation("agent", agents);
  execution.registerImplementation("workflow", {
    async start() {
      throw new Error("not used");
    },
  });
  execution.seal();

  const root = "root-budget-resume" as RunId;
  await execution.initializeRoot({ id: root, session: { sessionId: "root", cwd: process.cwd() } });
  const handle = await execution.start({
    parentId: root,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "Preserve this session while requesting more budget" },
    wait: "await",
  });
  const current = store.projection.requireRun(handle.id).compiled.limits;
  const suggested = increasedLimit(current);

  await backend.tool("phenix_fail").execute({
    summary: "More budget is required to finish without losing context",
    category: "resource_limit",
    retryable: true,
    suggestedLimits: suggested,
  });

  const suspended = pendingBudgetSuspension(store, handle.id);
  assert.ok(suspended);
  assert.equal(store.projection.requireRun(handle.id).state, "waiting");
  assert.equal(backend.createCalls, 1);
  assert.equal(backend.session.disposed, false);
  assert.equal(backend.session.followUps.length, 0);
  assert.equal(store.projection.requireRun(handle.id).pi?.sessionId, "same-budget-session");

  await execution.send(handle.id, encodeBudgetResumeControl({}));

  assert.equal(store.projection.requireRun(handle.id).state, "running");
  assert.equal(pendingBudgetSuspension(store, handle.id), undefined);
  assert.equal(backend.createCalls, 1);
  assert.equal(backend.session.disposed, false);
  assert.equal(backend.session.followUps.length, 1);
  assert.match(backend.session.followUps[0] ?? "", /existing session state/);
  assert.equal(store.projection.requireRun(handle.id).pi?.sessionId, "same-budget-session");

  await execution.cancel(handle.id, "test cleanup");
});

function increasedLimit(limits: {
  readonly timeoutMs: number;
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxRepairAttempts?: number;
}): RunRetryLimitOverrides {
  if (limits.maxTurns !== undefined && limits.maxTurns < 200) {
    return { maxTurns: limits.maxTurns + 1 };
  }
  if (limits.maxToolCalls !== undefined && limits.maxToolCalls < 1_000) {
    return { maxToolCalls: limits.maxToolCalls + 1 };
  }
  if (limits.maxRepairAttempts !== undefined && limits.maxRepairAttempts < 10) {
    return { maxRepairAttempts: limits.maxRepairAttempts + 1 };
  }
  if (limits.timeoutMs > 0 && limits.timeoutMs < 3_600_000) {
    return { timeoutMs: Math.min(3_600_000, limits.timeoutMs + 60_000) };
  }
  throw new Error("Agent definition has no bounded budget that can be increased for this test");
}
