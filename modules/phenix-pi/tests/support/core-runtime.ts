import { InMemoryRunLedger } from "../../adapters/persistence/in-memory-run-ledger.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../../application/catalog.ts";
import { OrderedDomainEventBus } from "../../application/domain-event-bus.ts";
import {
  ExecutionFacadeImpl,
  type RunController,
  type RunImplementation,
  type StartImplementationCommand,
} from "../../application/execution-facade.ts";
import { ExecutionStore } from "../../application/execution-store.ts";
import { QueryFacadeImpl } from "../../application/query-facade.ts";
import { TaskFacadeImpl } from "../../application/task-facade.ts";
import { WorkflowProcessManager } from "../../application/workflow-process-manager.ts";
import { agentDefinitions } from "../../definitions/agents.ts";
import {
  AGENT_ARCHITECT,
  AGENT_BASE,
  AGENT_COORDINATOR,
  AGENT_CRITIC,
  AGENT_DISPATCHER,
  AGENT_FINALIZER,
  AGENT_IMPLEMENTER,
  AGENT_PLANNER,
  AGENT_QA_SYNTHESIZER,
  AGENT_SCOUT,
  AGENT_TESTER,
  AGENT_VERIFIER,
} from "../../definitions/ids.ts";
import { registerWorkflowFunctions } from "../../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../../definitions/workflows/index.ts";
import type { AnyDefinition } from "../../domain/definition/definition.ts";
import type { ResolvedModel } from "../../domain/definition/model.ts";
import type { DefinitionId, RunId } from "../../domain/shared.ts";
import type { Clock, IdGenerator } from "../../ports/clock.ts";
import type { LocalOperationRunner } from "../../ports/local-operation-runner.ts";
import type { ModelResolver } from "../../ports/model-resolver.ts";

class TestIds implements IdGenerator {
  private value = 0;
  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${this.value}`;
  }
}

const clock: Clock = { now: () => "2026-01-01T00:00:00.000Z" };
const models: ModelResolver = {
  async resolve(selector, context): Promise<ResolvedModel> {
    return {
      requested: selector,
      concrete: { kind: "concrete", provider: "test", model: "model" },
      thinking: context.thinking === "route" ? "medium" : context.thinking,
      policyRevision: "test",
    };
  },
};
const operations: LocalOperationRunner = {
  has: (operation) => operation === "local.noop" || operation === "local.qa-checks",
  async run(operation, input) {
    if (operation === "local.qa-checks") {
      return [{ command: "test", ok: true, summary: "passed" }];
    }
    return input;
  },
};

export interface TestRuntime {
  readonly execution: ExecutionFacadeImpl;
  readonly controller: RunController;
  readonly store: ExecutionStore;
  readonly tasks: TaskFacadeImpl;
  readonly queries: QueryFacadeImpl;
  readonly rootRunId: RunId;
}

export interface TestRuntimeOptions {
  readonly modelResolver?: ModelResolver;
  readonly operations?: LocalOperationRunner;
  readonly rootInvokableDefinitions?: readonly DefinitionId[];
}

export async function createTestRuntime(
  agentImplementation?: RunImplementation,
  options: TestRuntimeOptions = {},
): Promise<TestRuntime> {
  const ids = new TestIds();
  const events = new OrderedDomainEventBus();
  const store = new ExecutionStore({
    ledger: new InMemoryRunLedger(),
    events,
    clock,
    ids,
  });
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const catalog = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions])
    catalog.register(definition);
  const operationRunner = options.operations ?? operations;
  catalog.seal(functions, operationRunner);
  const execution = new ExecutionFacadeImpl({
    catalog,
    store,
    models: options.modelResolver ?? models,
    ids,
    clock,
    rootInvokableDefinitions: options.rootInvokableDefinitions,
  });
  const tasks = new TaskFacadeImpl({ store, catalog, clock, ids });
  const workflows = new WorkflowProcessManager({
    invoker: execution.childInvoker(),
    controller: execution,
    operations: operationRunner,
    store,
    catalog,
    functions,
    tasks,
    ids,
    cwd: process.cwd(),
    clock,
  });
  execution.registerImplementation(
    "agent",
    agentImplementation ?? new ScriptedAgentImplementation(execution),
  );
  execution.registerImplementation("workflow", workflows);
  execution.seal();
  const rootRunId = "root-test" as RunId;
  await execution.initializeRoot({
    id: rootRunId,
    session: { sessionId: "test", cwd: process.cwd() },
  });
  return {
    execution,
    controller: execution,
    store,
    tasks,
    queries: new QueryFacadeImpl(store, tasks),
    rootRunId,
  };
}

class ScriptedAgentImplementation implements RunImplementation {
  private readonly controller: RunController;

  constructor(controller: RunController) {
    this.controller = controller;
  }

  async start(command: StartImplementationCommand): Promise<void> {
    await this.controller.transition(command.runId, "starting");
    await this.controller.transition(command.runId, "running");
    await this.controller.complete(command.runId, outputFor(command.definition));
  }
}

function outputFor(definition: AnyDefinition): unknown {
  if (definition.id === AGENT_PLANNER) {
    return { summary: "plan", steps: ["edit"], constraints: [], checks: ["test"] };
  }
  if (definition.id === AGENT_IMPLEMENTER) {
    return {
      summary: "implemented",
      changedFiles: ["src/file.ts"],
      checks: [{ command: "test", ok: true, summary: "passed" }],
      unresolved: [],
    };
  }
  if (definition.id === AGENT_VERIFIER) {
    return { accepted: true, summary: "accepted", findings: [], evidence: ["tests pass"] };
  }
  if (definition.id === AGENT_SCOUT) {
    return { summary: "scouted", evidence: [{ path: "src/file.ts", finding: "ok" }], risks: [] };
  }
  if (definition.id === AGENT_TESTER) {
    return {
      summary: "checks passed",
      checks: [{ command: "test", ok: true, summary: "passed" }],
      findings: [],
      evidence: ["test passed"],
    };
  }
  if (definition.id === AGENT_ARCHITECT || definition.id === AGENT_CRITIC) {
    return { summary: "reviewed", findings: [] };
  }
  if (definition.id === AGENT_QA_SYNTHESIZER) {
    return { summary: "clean", findings: [], reports: [] };
  }
  if (definition.id === AGENT_DISPATCHER) {
    return { route: "coordinate", reason: "requires composition", confidence: 0.8 };
  }
  if (
    definition.id === AGENT_BASE ||
    definition.id === AGENT_COORDINATOR ||
    definition.id === AGENT_FINALIZER
  ) {
    return { summary: "done", artifacts: [], unresolved: [] };
  }
  throw new Error(`No scripted output for ${definition.id}`);
}

export class PendingAgentImplementation implements RunImplementation {
  private readonly controller: RunController;
  readonly cancelled: RunId[] = [];

  constructor(controller: RunController) {
    this.controller = controller;
  }

  async start(command: StartImplementationCommand): Promise<void> {
    await this.controller.transition(command.runId, "starting");
    await this.controller.transition(command.runId, "running");
  }

  async cancel(runId: RunId): Promise<void> {
    this.cancelled.push(runId);
  }
}
