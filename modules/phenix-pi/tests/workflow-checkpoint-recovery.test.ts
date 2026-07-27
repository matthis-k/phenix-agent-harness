import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRunLedger } from "../adapters/persistence/in-memory-run-ledger.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import {
  ExecutionFacadeImpl,
  type RunImplementation,
  type StartImplementationCommand,
} from "../application/execution-facade.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import { TaskFacadeImpl } from "../application/task-facade.ts";
import { WorkflowCheckpointProcessManager } from "../application/workflow-checkpoint-process-manager.ts";
import { WorkflowProcessManager } from "../application/workflow-process-manager.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { WORKFLOW_IMPLEMENT } from "../definitions/ids.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { ResolvedModel } from "../domain/definition/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";
import type { ModelResolver } from "../ports/model-resolver.ts";

const rootRunId = "root-checkpoint-recovery" as RunId;
const clock: Clock = { now: () => "2026-01-01T00:00:00.000Z" };
const models: ModelResolver = {
  async resolve(selector, context): Promise<ResolvedModel> {
    return {
      requested: selector,
      concrete: { kind: "concrete", provider: "test", model: "model" },
      thinking: context.thinking === "route" ? "medium" : context.thinking,
      capability: context.capability ?? "general",
    };
  },
};
const operations: LocalOperationRunner = {
  has: (operation) => operation === "local.noop" || operation === "local.qa-checks",
  async run(_operation, input) {
    return input;
  },
};

class PrefixIds implements IdGenerator {
  private value = 0;
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  next(kind: string): string {
    this.value += 1;
    return `${kind}-${this.prefix}-${this.value}`;
  }
}

class RecoverablePendingAgent implements RunImplementation {
  starts = 0;
  recoveries = 0;
  private readonly controller: ExecutionFacadeImpl;

  constructor(controller: ExecutionFacadeImpl) {
    this.controller = controller;
  }

  async start(command: StartImplementationCommand): Promise<void> {
    this.starts += 1;
    await this.controller.transition(command.runId, "starting");
    await this.controller.transition(command.runId, "running");
  }

  async recover(): Promise<boolean> {
    this.recoveries += 1;
    return true;
  }
}

interface CheckpointRuntime {
  readonly execution: ExecutionFacadeImpl;
  readonly store: ExecutionStore;
  readonly events: OrderedDomainEventBus;
  readonly workflows: WorkflowProcessManager;
  readonly checkpoints: WorkflowCheckpointProcessManager;
  readonly agents: RecoverablePendingAgent;
}

async function createRuntime(
  ledger: InMemoryRunLedger,
  prefix: string,
): Promise<CheckpointRuntime> {
  const ids = new PrefixIds(prefix);
  const events = new OrderedDomainEventBus();
  const store = new ExecutionStore({ ledger, events, clock, ids });
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const catalog = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions])
    catalog.register(definition);
  catalog.seal(functions, operations);

  const execution = new ExecutionFacadeImpl({
    catalog,
    store,
    models,
    ids,
    clock,
    rootInvokableDefinitions: [WORKFLOW_IMPLEMENT],
  });
  const tasks = new TaskFacadeImpl({ store, catalog, clock, ids });
  const workflows = new WorkflowProcessManager({
    invoker: execution.childInvoker(),
    controller: execution,
    operations,
    store,
    catalog,
    functions,
    tasks,
    ids,
    cwd: process.cwd(),
    clock,
    resolveSchema: resolveDefinitionSchema,
  });
  const checkpoints = new WorkflowCheckpointProcessManager({ store, catalog });
  const agents = new RecoverablePendingAgent(execution);
  execution.registerImplementation("agent", agents);
  execution.registerImplementation("workflow", workflows);
  execution.seal();
  await execution.initializeRoot({
    id: rootRunId,
    session: { sessionId: "checkpoint-recovery", cwd: process.cwd() },
  });
  return { execution, store, events, workflows, checkpoints, agents };
}

test("recovery resumes a checkpointed activation without starting a duplicate child", async () => {
  const ledger = new InMemoryRunLedger();
  const first = await createRuntime(ledger, "first");
  const handle = await first.execution.start({
    parentId: rootRunId,
    definition: definitionRef(WORKFLOW_IMPLEMENT),
    input: { objective: "Survive a runtime restart" },
    wait: "await",
  });
  await first.events.drain();
  await first.checkpoints.checkpoint(handle.id);

  assert.equal(first.agents.starts, 1);
  assert.equal(first.store.projection.childrenOf(handle.id).length, 1);
  assert.ok(
    first.store.projection
      .eventsFor(handle.id)
      .some((event) => event.type === "workflow.checkpoint.saved"),
  );
  await first.checkpoints.shutdown();
  await first.workflows.shutdown();

  const second = await createRuntime(ledger, "second");
  await second.execution.recoverNonterminal(rootRunId);
  await second.events.drain();

  const workflow = second.store.projection.requireRun(handle.id);
  assert.equal(workflow.state, "waiting");
  assert.equal(second.agents.starts, 0);
  assert.equal(second.agents.recoveries, 1);
  assert.equal(second.store.projection.childrenOf(handle.id).length, 1);

  await second.execution.cancel(handle.id, "checkpoint recovery test complete");
  await second.events.drain();
  await second.checkpoints.shutdown();
  await second.workflows.shutdown();
});
