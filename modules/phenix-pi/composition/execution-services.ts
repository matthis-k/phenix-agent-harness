import { PiSdkAgentSessionBackend } from "../adapters/pi-sdk/agent-session-backend.ts";
import { PhenixModelResolver } from "../adapters/routing/phenix-model-resolver.ts";
import { PiModelInventory } from "../adapters/routing/pi-model-inventory.ts";
import { AgentExecutor } from "../application/agent-executor.ts";
import { FacadeAgentToolFactory } from "../application/agent-tools.ts";
import { AttentionProcessManager } from "../application/attention-process-manager.ts";
import { CatalogFacadeImpl } from "../application/catalog-facade.ts";
import { DispatchService } from "../application/dispatch-service.ts";
import { DynamicWorkflowExecutionService } from "../application/dynamic-workflow-execution.ts";
import { ExecutionFacadeImpl } from "../application/execution-facade.ts";
import { SessionInvocationPolicy } from "../application/invocation-policy.ts";
import { ModelExecutionFacade } from "../application/model-execution-facade.ts";
import { ProfileAwareModelResolver } from "../application/profile-aware-model-resolver.ts";
import { QueryFacadeImpl } from "../application/query-facade.ts";
import { SupervisionProcessManager } from "../application/supervision-process-manager.ts";
import { TaskFacadeImpl } from "../application/task-facade.ts";
import { WorkflowCheckpointProcessManager } from "../application/workflow-checkpoint-process-manager.ts";
import { WorkflowProcessManager } from "../application/workflow-process-manager.ts";
import { ROOT_DISPATCH_DEFINITION_IDS, ROOT_INTERNAL_DEFINITION_IDS } from "../definitions/ids.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import { systemClock } from "../ports/clock.ts";
import type { DefinitionRuntime } from "./definition-runtime.ts";
import type { PhenixHostServices } from "./host-services.ts";
import type { RuntimeInfrastructure } from "./runtime-infrastructure.ts";

export interface ExecutionServices {
  readonly execution: ExecutionFacadeImpl;
  readonly dynamicWorkflows: DynamicWorkflowExecutionService;
  readonly tasks: TaskFacadeImpl;
  readonly catalog: CatalogFacadeImpl;
  readonly queries: QueryFacadeImpl;
  readonly tools: FacadeAgentToolFactory;
  readonly workflows: WorkflowProcessManager;
  readonly checkpoints: WorkflowCheckpointProcessManager;
  readonly agents: AgentExecutor;
  readonly attention: AttentionProcessManager;
  readonly supervision: SupervisionProcessManager;
}

export function createExecutionServices(input: {
  readonly host: PhenixHostServices;
  readonly infrastructure: RuntimeInfrastructure;
  readonly definitionRuntime: DefinitionRuntime;
  readonly currentProfile: () => Promise<SessionProfile>;
  readonly notifyRoot: (message: string) => void | Promise<void> | undefined;
}): ExecutionServices {
  const { host, infrastructure, definitionRuntime } = input;
  const { ids, store, operations } = infrastructure;
  const { definitions, functions, dynamicRegistry } = definitionRuntime;

  const baseResolver = new PhenixModelResolver(new PiModelInventory(host.modelRegistry));
  const resolver = new ProfileAwareModelResolver(baseResolver, input.currentProfile);
  const execution = new ExecutionFacadeImpl({
    catalog: definitions,
    store,
    models: resolver,
    ids,
    clock: systemClock,
    rootInvokableDefinitions: [...ROOT_DISPATCH_DEFINITION_IDS, ...ROOT_INTERNAL_DEFINITION_IDS],
  });
  const modelExecution = new ModelExecutionFacade({
    execution,
    store,
    hiddenDefinitions: ROOT_INTERNAL_DEFINITION_IDS,
  });
  const tasks = new TaskFacadeImpl({
    store,
    catalog: definitions,
    clock: systemClock,
    ids,
  });
  const catalog = new CatalogFacadeImpl(definitions, store, {
    hiddenDefinitions: ROOT_INTERNAL_DEFINITION_IDS,
  });
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
    cwd: host.cwd,
    clock: systemClock,
    resolveSchema: resolveDefinitionSchema,
  });
  const checkpoints = new WorkflowCheckpointProcessManager({ store, catalog: definitions });
  const dynamicWorkflows = new DynamicWorkflowExecutionService({
    registry: dynamicRegistry,
    catalog,
    store,
    controller: execution,
    workflow: workflows,
    execution,
    ids,
    clock: systemClock,
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
  const backend = new PiSdkAgentSessionBackend({
    modelRegistry: host.modelRegistry,
    agentDir: host.agentDir,
    eventBus: host.piEventBus,
    promptModeForRun: (runId) => {
      const run = store.projection.requireRun(runId);
      const definition = definitions.require(run.definitionId);
      return definition.kind === "agent" ? definition.promptMode : undefined;
    },
  });
  const agents = new AgentExecutor({
    backend,
    controller: execution,
    tools,
    store,
    cwd: host.cwd,
    clock: systemClock,
  });

  execution.registerImplementation("agent", agents);
  execution.registerImplementation("workflow", workflows);
  execution.seal();

  const queries = new QueryFacadeImpl(store, tasks);
  const attention = new AttentionProcessManager({
    execution,
    store,
    ids,
    clock: systemClock,
    notifyRoot: input.notifyRoot,
  });
  const supervision = new SupervisionProcessManager({
    execution,
    store,
    notifyRoot: input.notifyRoot,
  });

  return {
    execution,
    dynamicWorkflows,
    tasks,
    catalog,
    queries,
    tools,
    workflows,
    checkpoints,
    agents,
    attention,
    supervision,
  };
}
