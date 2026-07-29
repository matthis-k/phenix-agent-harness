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
  const execution = new ExecutionFacadeImpl({
    catalog: input.definitions,
    store: input.store,
    models: input.models,
    ids: input.ids,
    clock: input.clock,
    ...(input.rootInvokableDefinitions !== undefined
      ? { rootInvokableDefinitions: input.rootInvokableDefinitions }
      : {}),
  });
  const visibility =
    input.hiddenDefinitions !== undefined
      ? { hiddenDefinitions: input.hiddenDefinitions }
      : undefined;
  const modelExecution = new ModelExecutionFacade({
    execution,
    store: input.store,
    ...(visibility ?? {}),
  });
  const tasks = new TaskFacadeImpl({
    store: input.store,
    catalog: input.definitions,
    clock: input.clock,
    ids: input.ids,
  });
  const catalog = new CatalogFacadeImpl(input.definitions, input.store, visibility);
  const invocationPolicy = new SessionInvocationPolicy({
    store: input.store,
    catalog: input.definitions,
  });
  const workflows = new WorkflowProcessManager({
    invoker: execution.childInvoker(),
    controller: execution,
    operations: input.operations,
    store: input.store,
    catalog: input.definitions,
    functions: input.functions,
    tasks,
    ids: input.ids,
    cwd: input.cwd,
    clock: input.clock,
    resolveSchema: input.resolveSchema,
  });
  const checkpoints = new WorkflowCheckpointProcessManager({
    store: input.store,
    catalog: input.definitions,
  });
  const dynamicRegistry = new DynamicWorkflowRuntimeRegistry({
    compiler: new DynamicWorkflowCompiler({
      resolveDefinition: (id) => input.definitions.require(id),
      resolveSchema: input.resolveSchema,
    }),
    catalog: input.definitions,
    functions: input.functions,
  });
  const dynamicWorkflows = new DynamicWorkflowExecutionService({
    registry: dynamicRegistry,
    catalog,
    store: input.store,
    controller: execution,
    workflow: workflows,
    execution,
    ids: input.ids,
    clock: input.clock,
  });
  const dispatch = new DispatchService({
    execution: modelExecution,
    dynamicWorkflows,
    catalog,
    store: input.store,
    invocationPolicy,
  });

  return {
    execution,
    modelExecution,
    tasks,
    catalog,
    invocationPolicy,
    workflows,
    checkpoints,
    dynamicWorkflows,
    dispatch,
    queries: new QueryFacadeImpl(input.store, tasks),
  } as const;
}
