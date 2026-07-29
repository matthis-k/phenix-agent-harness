import { FacadeAgentToolFactory } from "../application/agent-tools.ts";
import type { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { CatalogFacadeImpl } from "../application/catalog-facade.ts";
import { DispatchService } from "../application/dispatch-service.ts";
import { DynamicWorkflowCompiler } from "../application/dynamic-workflow-compiler.ts";
import { DynamicWorkflowExecutionService } from "../application/dynamic-workflow-execution.ts";
import { DynamicWorkflowRuntimeRegistry } from "../application/dynamic-workflow-runtime.ts";
import { ExecutionFacadeImpl } from "../application/execution-facade.ts";
import type { ExecutionStore } from "../application/execution-store.ts";
import { SessionInvocationPolicy } from "../application/invocation-policy.ts";
import { ModelExecutionFacade } from "../application/model-execution-facade.ts";
import { QueryFacadeImpl } from "../application/query-facade.ts";
import { TaskFacadeImpl } from "../application/task-facade.ts";
import { WorkflowCheckpointProcessManager } from "../application/workflow-checkpoint-process-manager.ts";
import { WorkflowProcessManager } from "../application/workflow-process-manager.ts";
import type { Schema } from "../domain/definition/schema.ts";
import type { DefinitionId } from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";
import type { ModelResolver } from "../ports/model-resolver.ts";

interface ExecutionKernelDependencies {
  readonly definitions: DefinitionCatalog;
  readonly functions: WorkflowFunctionRegistry;
  readonly operations: LocalOperationRunner;
  readonly store: ExecutionStore;
  readonly models: ModelResolver;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly cwd: string;
  readonly resolveSchema: (id: string) => Schema<unknown>;
  readonly rootInvokableDefinitions?: readonly DefinitionId[];
  readonly hiddenDefinitions?: readonly DefinitionId[];
}

/** Assemble the runtime-independent execution kernel once for production and tests. */
export function createExecutionKernel(input: ExecutionKernelDependencies) {
  const { definitions, functions, operations, store, models, ids, clock, cwd, resolveSchema } = input;
  const execution = new ExecutionFacadeImpl({
    catalog: definitions,
    store,
    models,
    ids,
    clock,
    ...(input.rootInvokableDefinitions !== undefined
      ? { rootInvokableDefinitions: input.rootInvokableDefinitions }
      : {}),
  });
  const visibility = { hiddenDefinitions: input.hiddenDefinitions ?? [] };
  const modelExecution = new ModelExecutionFacade({ execution, store, ...visibility });
  const tasks = new TaskFacadeImpl({ store, catalog: definitions, clock, ids });
  const catalog = new CatalogFacadeImpl(definitions, store, visibility);
  const invocationPolicy = new SessionInvocationPolicy({ store, catalog: definitions });
  const workflows = new WorkflowProcessManager({
    invoker: execution.childInvoker(),
    controller: execution,
    operations,
    store,
    catalog: definitions,
    functions,
    tasks,
    ids,
    cwd,
    clock,
    resolveSchema,
  });
  const checkpoints = new WorkflowCheckpointProcessManager({ store, catalog: definitions });
  const dynamicWorkflows = new DynamicWorkflowExecutionService({
    registry: new DynamicWorkflowRuntimeRegistry({
      compiler: new DynamicWorkflowCompiler({
        resolveDefinition: (id) => definitions.require(id),
        resolveSchema,
      }),
      catalog: definitions,
      functions,
    }),
    catalog,
    store,
    controller: execution,
    workflow: workflows,
    execution,
    ids,
    clock,
  });
  const dispatch = new DispatchService({
    execution: modelExecution,
    dynamicWorkflows,
    catalog,
    store,
    invocationPolicy,
  });
  const tools = new FacadeAgentToolFactory({
    execution: modelExecution,
    dispatch,
    tasks,
    catalog,
    store,
    invocationPolicy,
  });

  return {
    execution,
    dynamicWorkflows,
    tasks,
    catalog,
    queries: new QueryFacadeImpl(store, tasks),
    tools,
    workflows,
    checkpoints,
    dispatch,
  } as const;
}
