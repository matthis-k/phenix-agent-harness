import { InMemoryRunLedger } from "../../adapters/persistence/in-memory-run-ledger.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../../application/catalog.ts";
import { CatalogFacadeImpl } from "../../application/catalog-facade.ts";
import { DispatchService } from "../../application/dispatch-service.ts";
import { OrderedDomainEventBus } from "../../application/domain-event-bus.ts";
import { DynamicWorkflowCompiler } from "../../application/dynamic-workflow-compiler.ts";
import { DynamicWorkflowExecutionService } from "../../application/dynamic-workflow-execution.ts";
import { DynamicWorkflowRuntimeRegistry } from "../../application/dynamic-workflow-runtime.ts";
import {
  ExecutionFacadeImpl,
  type RunController,
  type RunImplementation,
  type StartImplementationCommand,
} from "../../application/execution-facade.ts";
import { ExecutionStore } from "../../application/execution-store.ts";
import { SessionInvocationPolicy } from "../../application/invocation-policy.ts";
import { QueryFacadeImpl } from "../../application/query-facade.ts";
import { TaskFacadeImpl } from "../../application/task-facade.ts";
import { WorkflowCheckpointProcessManager } from "../../application/workflow-checkpoint-process-manager.ts";
import { WorkflowProcessManager } from "../../application/workflow-process-manager.ts";
import { agentDefinitions } from "../../definitions/agents.ts";
import type { DynamicWorkflowProposal } from "../../definitions/dynamic-workflow.ts";
import {
  AGENT_ARCHITECT,
  AGENT_COORDINATOR,
  AGENT_CRITIC,
  AGENT_DIFFICULTY_ESTIMATOR,
  AGENT_DISPATCHER,
  AGENT_FINALIZER,
  AGENT_GENERIC_READ,
  AGENT_GENERIC_WRITE,
  AGENT_IMPLEMENTER,
  AGENT_PLANNER,
  AGENT_QA_SYNTHESIZER,
  AGENT_SCOUT,
  AGENT_TESTER,
  AGENT_VERIFIER,
} from "../../definitions/ids.ts";
import { resolveDefinitionSchema } from "../../definitions/schema-registry.ts";
import { registerWorkflowFunctions } from "../../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../../definitions/workflows/index.ts";
import type { AnyDefinition } from "../../domain/definition/definition.ts";
import type { Difficulty, ResolvedModel } from "../../domain/definition/model.ts";
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
      capability: context.capability,
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
  readonly dynamicWorkflows: DynamicWorkflowExecutionService;
  readonly dispatch: DispatchService;
  readonly checkpoints: WorkflowCheckpointProcessManager;
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
  readonly definitions?: readonly AnyDefinition[];
  readonly estimatedDifficulty?: Difficulty;
  readonly registerFunctions?: (functions: WorkflowFunctionRegistry) => void;
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
  options.registerFunctions?.(functions);
  const catalog = new DefinitionCatalog();
  for (const definition of [
    ...agentDefinitions,
    ...workflowDefinitions,
    ...(options.definitions ?? []),
  ]) {
    catalog.register(definition);
  }
  const operationRunner = options.operations
    ? layeredOperations(options.operations, operations)
    : operations;
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
  const checkpoints = new WorkflowCheckpointProcessManager({ store, catalog });
  execution.registerImplementation(
    "agent",
    agentImplementation ??
      new ScriptedAgentImplementation(execution, options.estimatedDifficulty ?? "D1"),
  );
  execution.registerImplementation("workflow", workflows);
  execution.seal();
  const catalogFacade = new CatalogFacadeImpl(catalog, store);
  const dynamicRegistry = new DynamicWorkflowRuntimeRegistry({
    compiler: new DynamicWorkflowCompiler({
      resolveDefinition: (id) => catalog.require(id),
      resolveSchema: resolveDefinitionSchema,
    }),
    catalog,
    functions,
  });
  const dynamicWorkflows = new DynamicWorkflowExecutionService({
    registry: dynamicRegistry,
    catalog: catalogFacade,
    store,
    controller: execution,
    workflow: workflows,
    execution,
    ids,
    clock,
  });
  const dispatch = new DispatchService({
    execution,
    dynamicWorkflows,
    catalog: catalogFacade,
    store,
    invocationPolicy: new SessionInvocationPolicy({ store, catalog }),
  });
  const rootRunId = "root-test" as RunId;
  await execution.initializeRoot({
    id: rootRunId,
    session: { sessionId: "test", cwd: process.cwd() },
  });
  return {
    execution,
    dynamicWorkflows,
    dispatch,
    checkpoints,
    controller: execution,
    store,
    tasks,
    queries: new QueryFacadeImpl(store, tasks),
    rootRunId,
  };
}

class ScriptedAgentImplementation implements RunImplementation {
  private readonly controller: RunController;
  private readonly estimatedDifficulty: Difficulty;

  constructor(controller: RunController, estimatedDifficulty: Difficulty) {
    this.controller = controller;
    this.estimatedDifficulty = estimatedDifficulty;
  }

  async start(command: StartImplementationCommand): Promise<void> {
    await this.controller.transition(command.runId, "starting");
    await this.controller.transition(command.runId, "running");
    await this.controller.complete(
      command.runId,
      outputFor(command.definition, this.estimatedDifficulty, command.input),
    );
  }
}

function outputFor(
  definition: AnyDefinition,
  estimatedDifficulty: Difficulty,
  input: unknown,
): unknown {
  if (definition.id === AGENT_DIFFICULTY_ESTIMATOR) {
    return {
      difficulty: estimatedDifficulty,
      summary: `Scripted ${estimatedDifficulty} assessment`,
      signals: ["test fixture"],
    };
  }
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
    return {
      summary: "clean",
      checks: [{ command: "test", ok: true, summary: "passed" }],
      findings: [],
      reports: [],
    };
  }
  if (definition.id === AGENT_DISPATCHER) {
    return { definitionId: AGENT_COORDINATOR, reason: "requires composition", confidence: 0.8 };
  }
  if (definition.id === AGENT_COORDINATOR) {
    return compositionFixture(input);
  }
  if (
    definition.id === AGENT_GENERIC_READ ||
    definition.id === AGENT_GENERIC_WRITE ||
    definition.id === AGENT_FINALIZER
  ) {
    return { summary: "done", artifacts: [], unresolved: [] };
  }
  throw new Error(`No scripted output for ${definition.id}`);
}

function compositionFixture(input: unknown): DynamicWorkflowProposal {
  if (
    typeof input !== "object" ||
    input === null ||
    !("workflowInputSchema" in input) ||
    typeof input.workflowInputSchema !== "string"
  ) {
    throw new Error("Dynamic composition fixture requires workflowInputSchema");
  }
  return {
    title: "Composed repository scout",
    description: "Use one reusable scout for the uncovered repository question.",
    inputSchema: input.workflowInputSchema,
    outputSchema: "outcome.scout-report.v1",
    entry: "scout",
    nodes: [
      {
        kind: "invoke",
        id: "scout",
        definitionId: AGENT_SCOUT,
        input: {
          source: "object",
          fields: {
            objective: { source: "input", path: ["objective"] },
            focus: { source: "literal", value: "dynamic composition" },
          },
        },
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

function layeredOperations(
  primary: LocalOperationRunner,
  fallback: LocalOperationRunner,
): LocalOperationRunner {
  return {
    has: (operation) => primary.has(operation) || fallback.has(operation),
    run(operation, input, context) {
      return (primary.has(operation) ? primary : fallback).run(operation, input, context);
    },
  };
}
