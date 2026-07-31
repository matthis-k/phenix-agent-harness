import { randomUUID } from "node:crypto";
import path from "node:path";

import type { EventBus, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { GhProjectTracker } from "../adapters/github/gh-project-tracker.ts";
import { JsonlDiagnosticLog } from "../adapters/persistence/jsonl-diagnostic-log.ts";
import { JsonlProjectLedger } from "../adapters/persistence/jsonl-project-ledger.ts";
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
import { AttentionProcessManager } from "../application/attention-process-manager.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { logDomainEvent } from "../application/diagnostic-event-bridge.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import type { ExecutionFacade } from "../application/interfaces.ts";
import { ProfileAwareModelResolver } from "../application/profile-aware-model-resolver.ts";
import { ProjectPlannerService } from "../application/project-planner.ts";
import { PublishedProjectTracker } from "../application/published-project-tracker.ts";
import { SessionProfileFacadeImpl } from "../application/session-profile-facade.ts";
import { SupervisionProcessManager } from "../application/supervision-process-manager.ts";
import { UserFormService } from "../application/user-form-service.ts";
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
import { createExecutionKernel } from "./execution-kernel.ts";

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

export function createDefinitionRuntime(operations: ProcessLocalOperationRunner) {
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const definitions = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions]) {
    definitions.register(definition);
  }
  definitions.seal(functions, operations);
  return { functions, definitions };
}

export function createExecutionServices(input: {
  readonly host: PhenixHostServices;
  readonly infrastructure: ReturnType<typeof createRuntimeInfrastructure>;
  readonly definitionRuntime: ReturnType<typeof createDefinitionRuntime>;
  readonly currentProfile: () => Promise<SessionProfile>;
  readonly notifyRoot: (message: string) => void | Promise<void> | undefined;
}) {
  const { host, infrastructure, definitionRuntime } = input;
  const { ids, stateDir, store, operations } = infrastructure;
  const { definitions, functions } = definitionRuntime;
  const baseResolver = new PhenixModelResolver(
    new PiModelInventory(host.modelRegistry),
    host.routingPolicy,
  );
  const resolver = new ProfileAwareModelResolver(baseResolver, input.currentProfile);
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
  const kernel = createExecutionKernel({
    definitions,
    functions,
    operations,
    store,
    projects,
    userForms,
    models: resolver,
    ids,
    clock: systemClock,
    cwd: host.cwd,
    resolveSchema: resolveDefinitionSchema,
    rootInvokableDefinitions: [...ROOT_DISPATCH_DEFINITION_IDS, ...ROOT_INTERNAL_DEFINITION_IDS],
    hiddenDefinitions: ROOT_INTERNAL_DEFINITION_IDS,
  });
  const { execution, tasks, catalog, workflows, checkpoints, dynamicWorkflows, tools, queries } =
    kernel;
  projectExecution = execution;
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
    projects,
    userForms,
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
