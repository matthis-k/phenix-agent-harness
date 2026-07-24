import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRunLedger } from "../adapters/persistence/in-memory-run-ledger.ts";
import {
  AttentionProcessManager,
  type AttentionRouter,
  type AttentionRouterResult,
} from "../application/attention-process-manager.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import {
  ExecutionFacadeImpl,
  type RunImplementation,
  type StartImplementationCommand,
} from "../application/execution-facade.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { AGENT_BASE } from "../definitions/ids.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import type {
  AttentionRoutingDecision,
  AttentionRoutingRequest,
} from "../domain/attention/model.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { RunId } from "../domain/shared.ts";
import type { IdGenerator } from "../ports/clock.ts";

const NOW = "2026-07-24T12:00:00.000Z";

class Ids implements IdGenerator {
  private value = 0;

  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${this.value}`;
  }
}

class FakeRouter implements AttentionRouter {
  readonly requests: AttentionRoutingRequest[] = [];
  private readonly decide: (request: AttentionRoutingRequest) => AttentionRoutingDecision;

  constructor(decide: (request: AttentionRoutingRequest) => AttentionRoutingDecision) {
    this.decide = decide;
  }

  async route(
    _rootRunId: RunId,
    request: AttentionRoutingRequest,
  ): Promise<AttentionRouterResult> {
    this.requests.push(request);
    return { decision: this.decide(request) };
  }
}

class FakeAgentImplementation implements RunImplementation {
  readonly sent: Array<{
    readonly runId: RunId;
    readonly message: string;
    readonly delivery: "normal" | "nextTurn";
  }> = [];
  private readonly execution: ExecutionFacadeImpl;
  private readonly autoRun: boolean;

  constructor(execution: ExecutionFacadeImpl, autoRun: boolean) {
    this.execution = execution;
    this.autoRun = autoRun;
  }

  async start(command: StartImplementationCommand): Promise<void> {
    await this.execution.transition(command.runId, "starting");
    if (this.autoRun) await this.makeRunning(command.runId);
  }

  async send(
    runId: RunId,
    message: string,
    delivery: "normal" | "nextTurn",
  ): Promise<void> {
    this.sent.push({ runId, message, delivery });
  }

  async makeRunning(runId: RunId): Promise<void> {
    await this.execution.bindPi(runId, { sessionId: `fake-${runId}` });
    await this.execution.transition(runId, "running");
  }
}

interface Harness {
  readonly root: RunId;
  readonly execution: ExecutionFacadeImpl;
  readonly store: ExecutionStore;
  readonly agents: FakeAgentImplementation;
  readonly router: FakeRouter;
  readonly attention: AttentionProcessManager;
  readonly notices: string[];
}

async function createHarness(input: {
  readonly autoRun?: boolean;
  readonly decide: (request: AttentionRoutingRequest) => AttentionRoutingDecision;
}): Promise<Harness> {
  const ids = new Ids();
  const events = new OrderedDomainEventBus();
  const store = new ExecutionStore({
    ledger: new InMemoryRunLedger(),
    events,
    clock: { now: () => NOW },
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
    async run(_operation, value) {
      return value;
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
          thinking: "minimal",
          policyRevision: "test",
        };
      },
    },
    ids,
    clock: { now: () => NOW },
  });
  const agents = new FakeAgentImplementation(execution, input.autoRun ?? true);
  execution.registerImplementation("agent", agents);
  execution.registerImplementation("workflow", {
    async start() {
      throw new Error("not used");
    },
  });
  execution.seal();

  const root = "root-attention-test" as RunId;
  await execution.initializeRoot({ id: root, session: { sessionId: "root", cwd: process.cwd() } });
  const router = new FakeRouter(input.decide);
  const notices: string[] = [];
  const attention = new AttentionProcessManager({
    execution,
    store,
    router,
    ids,
    clock: { now: () => NOW },
    notifyRoot: (message) => {
      notices.push(message);
    },
  });
  return { root, execution, store, agents, router, attention, notices };
}

test("user follow-up immediately steers a selected running child without settling it", async () => {
  const harness = await createHarness({
    decide: (request) => ({
      targets: [
        {
          runId: request.candidates[0]?.runId as RunId,
          delivery: "urgent",
          reason: "The child is implementing the affected behavior",
        },
      ],
      reason: "One active implementation target",
    }),
  });
  const child = await harness.execution.start({
    parentId: harness.root,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "Implement the runtime change" },
    wait: "await",
  });

  await harness.execution.amendRootInput(harness.root, "Focus on the deadlock before cleanup.");
  await eventually(() => hasEvent(harness, "attention.delivered"));

  assert.deepEqual(harness.agents.sent[0], {
    runId: child.id,
    message: "Focus on the deadlock before cleanup.",
    delivery: "normal",
  });
  assert.equal(harness.store.projection.requireRun(child.id).state, "running");
  assert.equal(harness.store.projection.requireRun(child.id).outcome, undefined);
  assert.ok(hasEvent(harness, "attention.received"));
  assert.ok(hasEvent(harness, "attention.routed"));
  await harness.attention.shutdown();
});

test("attention is durably deferred until a starting child binds its session", async () => {
  const harness = await createHarness({
    autoRun: false,
    decide: (request) => ({
      targets: [
        {
          runId: request.candidates[0]?.runId as RunId,
          delivery: "urgent",
          reason: "The child is the active target",
        },
      ],
      reason: "One active target",
    }),
  });
  const child = await harness.execution.start({
    parentId: harness.root,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "Prepare implementation" },
    wait: "await",
  });

  await harness.execution.amendRootInput(harness.root, "Use the revised API boundary.");
  await eventually(() => hasEvent(harness, "attention.delivery.deferred"));
  assert.equal(harness.agents.sent.length, 0);

  await harness.agents.makeRunning(child.id);
  await eventually(() => hasEvent(harness, "attention.delivered"));

  const delivered = harness.store.projection.events.find(
    (event) => event.type === "attention.delivered",
  );
  assert.equal(
    (delivered?.data as { readonly deferred?: boolean } | undefined)?.deferred,
    true,
  );
  assert.equal(harness.agents.sent.length, 1);
  await harness.attention.shutdown();
});

test("an explicit run id bypasses model routing", async () => {
  const harness = await createHarness({
    decide: () => {
      throw new Error("router should not be called");
    },
  });
  const child = await harness.execution.start({
    parentId: harness.root,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "Inspect the repository" },
    wait: "background",
  });

  await harness.execution.amendRootInput(
    harness.root,
    `Steer ${child.id}: inspect the state transition first.`,
  );
  await eventually(() => hasEvent(harness, "attention.delivered"));

  assert.equal(harness.router.requests.length, 0);
  assert.equal(harness.agents.sent[0]?.runId, child.id);
  await harness.attention.shutdown();
});

test("model routing may keep a follow-up with the root supervisor", async () => {
  const harness = await createHarness({
    decide: () => ({
      targets: [],
      reason: "The message changes orchestration rather than child work",
    }),
  });
  await harness.execution.start({
    parentId: harness.root,
    definition: definitionRef(AGENT_BASE),
    input: { objective: "Run QA" },
    wait: "background",
  });

  await harness.execution.amendRootInput(harness.root, "Stop QA and start implementation instead.");
  await eventually(() => harness.notices.length === 1);

  assert.equal(harness.agents.sent.length, 0);
  assert.match(harness.notices[0] ?? "", /root supervisor/);
  await harness.attention.shutdown();
});

function hasEvent(harness: Harness, type: string): boolean {
  return harness.store.projection.events.some(
    (event) => event.type === type && event.runId === harness.root,
  );
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}
