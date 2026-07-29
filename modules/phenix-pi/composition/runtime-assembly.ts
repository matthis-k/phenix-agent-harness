import { randomUUID } from "node:crypto";
import path from "node:path";

import type { EventBus, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { JsonlDiagnosticLog } from "../adapters/persistence/jsonl-diagnostic-log.ts";
import { JsonlRunLedger } from "../adapters/persistence/jsonl-run-ledger.ts";
import { PiSdkAgentSessionBackend } from "../adapters/pi-sdk/agent-session-backend.ts";
import { LiveAgentTranscriptStore } from "../adapters/pi-sdk/live-agent-transcript-store.ts";
import { ProcessLocalOperationRunner } from "../adapters/process/local-operation-runner.ts";
import {
  PhenixModelResolver,
  type RoutingPolicy,
} from "../adapters/routing/phenix-model-resolver.ts";
import { PiModelInventory } from "../adapters/routing/pi-model-inventory.ts";
import { AgentExecutor } from "../application/agent-executor.ts";
import { FacadeAgentToolFactory } from "../application/agent-tools.ts";
import { AttentionProcessManager } from "../application/attention-process-manager.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { CatalogFacadeImpl } from "../application/catalog-facade.ts";
import { logDomainEvent } from "../application/diagnostic-event-bridge.ts";
import { DispatchService } from "../application/dispatch-service.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import { DynamicWorkflowCompiler } from "../application/dynamic-workflow-compiler.ts";
import { DynamicWorkflowExecutionService } from "../application/dynamic-workflow-execution.ts";
import { DynamicWorkflowRuntimeRegistry } from "../application/dynamic-workflow-runtime.ts";
import { ExecutionFacadeImpl } from "../application/execution-facade.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import { SessionInvocationPolicy } from "../application/invocation-policy.ts";
import { ModelExecutionFacade } from "../application/model-execution-facade.ts";
import { ProfileAwareModelResolver } from "../application/profile-aware-model-resolver.ts";
import { QueryFacadeImpl } from "../application/query-facade.ts";
import { SessionProfileFacadeImpl } from "../application/session-profile-facade.ts";
import { SupervisionProcessManager } from "../application/supervision-process-manager.ts";
import { TaskFacadeImpl } from "../application/task-facade.ts";
import { WorkflowCheckpointProcessManager } from "../application/workflow-checkpoint-process-manager.ts";
import { WorkflowProcessManager } from "../application/workflow-process-manager.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { ROOT_DISPATCH_DEFINITION_IDS, ROOT_INTERNAL_DEFINITION_IDS } from "../definitions/ids.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import type { IdGenerator } from "../ports/clock.ts";
import { systemClock } from "../ports/clock.ts";
import type { DiagnosticLog } from "../ports/diagnostic-log.ts";
import type { RunLedger } from "../ports/run-ledger.ts";

export interface PhenixHostServices {
  readonly cwd: string;
  readonly agentDir: string;
  readonly stateDir?: string;
  readonly modelRegistry: ModelRegistry;
  readonly routingPolicy?: RoutingPolicy;
  readonly piEventBus?: EventBus;
  readonly ledger?: RunLedger;
  readonly diagnostics?: DiagnosticLog;
  readonly ids?: IdGenerator;
}

export function createRuntimeInfrastructure(host: PhenixHostServices) {
  const ids = host.ids ?? new CryptoIdGenerator();
  const stateDir = host.stateDir ?? path.join(host.cwd, ".phenix-agent-state");
  const diagnostics = host.diagnostics ?? new JsonlDiagnosticLog(stateDir);
  const events = createDomainEventBus(diagnostics);
  const ledger = host.ledger ?? new JsonlRunLedger(stateDir);
  const store = new ExecutionStore({ ledger, events, clock: systemClock, ids });
  const unsubscribeDiagnostics = events.subscribe((event) => logDomainEvent(diagnostics, event));
  const profiles = new SessionProfileFacadeImpl(store);
  const operations = new ProcessLocalOperationRunner();
  return {
    ids,
    diagnostics,
    events,
    ledger,
    store,
    unsubscribeDiagnostics,
    profiles,
    operations,
  };
}

export function createDefinitionRuntime(operations: ProcessLocalOperationRunner) {
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const definitions = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions]) {
    definitions.register(definition);
  }
  definitions.seal(functions, operations);
  const dynamicRegistry = new DynamicWorkflowRuntimeRegistry({
    compiler: new DynamicWorkflowCompiler({
      resolveDefinition: (id) => definitions.require(id),
      resolveSchema: resolveDefinitionSchema,
    }),
    catalog: definitions,
    functions,
  });
  return { functions, definitions, dynamicRegistry };
}

export function createExecutionServices(input: {
  readonly host: PhenixHostServices;
  readonly infrastructure: ReturnType<typeof createRuntimeInfrastructure>;
  readonly definitionRuntime: ReturnType<typeof createDefinitionRuntime>;
  readonly currentProfile: () => Promise<SessionProfile>;
  readonly notifyRoot: (message: string) => void | Promise<void> | undefined;
}) {
  const { host, infrastructure, definitionRuntime } = input;
  const { ids, store, operations } = infrastructure;
  const { definitions, functions, dynamicRegistry } = definitionRuntime;
  const baseResolver = new PhenixModelResolver(
    new PiModelInventory(host.modelRegistry),
    host.routingPolicy,
  );
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
  const transcripts = new LiveAgentTranscriptStore();
  const backend = new PiSdkAgentSessionBackend({
    modelRegistry: host.modelRegistry,
    agentDir: host.agentDir,
    transcripts,
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
    transcripts,
    attention,
    supervision,
  };
}

export function createPiEventBridge(
  eventBus: EventBus | undefined,
  events: OrderedDomainEventBus,
): () => void {
  if (!eventBus) return () => undefined;
  return events.subscribe((event) => {
    eventBus.emit("phenix:domain-event", event);
  });
}

function createDomainEventBus(diagnostics: DiagnosticLog): OrderedDomainEventBus {
  return new OrderedDomainEventBus({
    onSubscriberError: async ({ event, error }) => {
      try {
        await diagnostics.record({
          rootRunId: event.rootRunId,
          runId: event.runId,
          ...(event.parentRunId ? { parentRunId: event.parentRunId } : {}),
          severity: "error",
          scope: "runtime.event.subscriber_failed",
          message: `Domain event subscriber failed for ${event.type}`,
          fields: { eventType: event.type, sequence: event.sequence, error },
        });
      } catch {
        console.error(
          `[phenix] domain event subscriber failed for ${event.type}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
}

class CryptoIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }
}
