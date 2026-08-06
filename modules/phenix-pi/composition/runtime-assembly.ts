import { randomUUID } from "node:crypto";
import path from "node:path";

import type { EventBus, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { GhProjectTracker } from "../adapters/github/gh-project-tracker.ts";
import { JsonlDiagnosticLog } from "../adapters/persistence/jsonl-diagnostic-log.ts";
import { JsonlMemoryRepository } from "../adapters/persistence/jsonl-memory-repository.ts";
import { JsonlProjectLedger } from "../adapters/persistence/jsonl-project-ledger.ts";
import { JsonlRunLedger } from "../adapters/persistence/jsonl-run-ledger.ts";
import { PiSdkAgentSessionBackend } from "../adapters/pi-sdk/agent-session-backend.ts";
import { LiveAgentTranscriptStore } from "../adapters/pi-sdk/live-agent-transcript-store.ts";
import { ProcessLocalOperationRunner } from "../adapters/process/local-operation-runner.ts";
import { ProcessRtkTokenReductionBackend } from "../adapters/process/rtk-token-reduction-backend.ts";
import { PiModelInventory } from "../adapters/routing/pi-model-inventory.ts";
import { AgentExecutor } from "../application/agent-executor.ts";
import { AttentionProcessManager } from "../application/attention-process-manager.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { logDomainEvent } from "../application/diagnostic-event-bridge.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import type { ExecutionFacade } from "../application/interfaces.ts";
import { MemoryService } from "../application/memory-service.ts";
import { ProjectPlannerService } from "../application/project-planner.ts";
import { PublishedProjectTracker } from "../application/published-project-tracker.ts";
import { SessionProfileFacadeImpl } from "../application/session-profile-facade.ts";
import { SupervisionProcessManager } from "../application/supervision-process-manager.ts";
import { UserFormService } from "../application/user-form-service.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import { AgentSessionBackendRouter } from "../framework/routing/agent-session-backend-router.ts";
import type { RuntimeConfiguration } from "../framework/runtime-configuration.ts";
import type { IdGenerator } from "../ports/clock.ts";
import { systemClock } from "../ports/clock.ts";
import type { DiagnosticLog } from "../ports/diagnostic-log.ts";
import type { RunLedger } from "../ports/run-ledger.ts";
import { createExecutionKernel } from "./execution-kernel.ts";

export interface PhenixHostServices {
  readonly cwd: string;
  readonly agentDir: string;
  readonly stateDir?: string;
  readonly modelRegistry: ModelRegistry;
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
    stateDir,
    diagnostics,
    events,
    ledger,
    store,
    unsubscribeDiagnostics,
    profiles,
    operations,
  };
}

export function createDefinitionRuntime(
  operations: ProcessLocalOperationRunner,
  configuration: RuntimeConfiguration,
) {
  const functions = new WorkflowFunctionRegistry();
  configuration.catalog.registerWorkflowFunctions(functions);
  const definitions = new DefinitionCatalog();
  for (const definition of configuration.catalog.definitions) {
    definitions.register(definition);
  }
  definitions.seal(functions, operations);
  return { functions, definitions };
}

export function createExecutionServices(input: {
  readonly host: PhenixHostServices;
  readonly configuration: RuntimeConfiguration;
  readonly infrastructure: ReturnType<typeof createRuntimeInfrastructure>;
  readonly definitionRuntime: ReturnType<typeof createDefinitionRuntime>;
  readonly currentProfile: () => Promise<SessionProfile>;
  readonly notifyRoot: (message: string) => void | Promise<void> | undefined;
}) {
  const { host, configuration, infrastructure, definitionRuntime } = input;
  const { ids, stateDir, store, operations } = infrastructure;
  const { definitions, functions } = definitionRuntime;
  const resolver = configuration.createModelResolver({
    inventory: new PiModelInventory(host.modelRegistry),
    currentProfile: input.currentProfile,
  });
  let projectExecution: ExecutionFacade | undefined;
  const projects = new ProjectPlannerService(
    new JsonlProjectLedger(stateDir),
    ids,
    systemClock,
    new PublishedProjectTracker(new GhProjectTracker(host.cwd)),
    input.notifyRoot,
    async (runId, message) => {
      if (!projectExecution) throw new Error("Execution runtime is not initialized");
      await projectExecution.send(runId, message);
    },
  );
  const userForms = new UserFormService(ids, systemClock);
  const memory = new MemoryService({
    repository: new JsonlMemoryRepository(stateDir),
    store,
    ids,
    clock: systemClock,
  });
  const tokenReduction =
    process.env.PHENIX_TOKEN_REDUCTION_BACKEND === "none" || !process.env.PHENIX_RTK_BIN
      ? undefined
      : new ProcessRtkTokenReductionBackend({
          executable: process.env.PHENIX_RTK_BIN,
          stateDirectory: stateDir,
        });
  const kernel = createExecutionKernel({
    definitions,
    functions,
    operations,
    store,
    projects,
    userForms,
    models: resolver,
    budgetPolicy: configuration.budgetPolicy,
    ids,
    clock: systemClock,
    cwd: host.cwd,
    resolveSchema: configuration.catalog.resolveDefinitionSchema,
    rootInvokableDefinitions: configuration.catalog.rootInvokableDefinitions,
    hiddenDefinitions: configuration.catalog.hiddenDefinitions,
  });
  const {
    execution,
    objectives,
    catalog,
    workflows,
    checkpoints,
    dynamicWorkflows,
    tools,
    queries,
  } = kernel;
  projectExecution = execution;
  const transcripts = new LiveAgentTranscriptStore();
  const piBackend = new PiSdkAgentSessionBackend({
    modelRegistry: host.modelRegistry,
    agentDir: host.agentDir,
    transcripts,
    memory,
    tokenReduction,
    eventBus: host.piEventBus,
    promptModeForRun: (runId) => {
      const run = store.projection.requireRun(runId);
      const definition = definitions.require(run.definitionId);
      return definition.kind === "agent" ? definition.promptMode : undefined;
    },
  });
  const backend = new AgentSessionBackendRouter({
    backends: new Map([["pi", piBackend]]),
    backendForRun: (runId) => {
      const target = store.projection.requireRun(runId).resolvedModel?.target;
      if (!target) throw new Error(`Run ${runId} has no resolved model target`);
      return target.backend;
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
    objectives,
    catalog,
    queries,
    tools,
    workflows,
    checkpoints,
    agents,
    transcripts,
    attention,
    supervision,
    projects,
    userForms,
    memory,
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
