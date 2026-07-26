import { JsonlRunLedger } from "../adapters/persistence/jsonl-run-ledger.ts";
import type { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import type { DynamicWorkflowExecutionService } from "../application/dynamic-workflow-execution.ts";
import type {
  AttentionFacade,
  CatalogFacade,
  ExecutionFacade,
  QueryFacade,
  SessionProfileFacade,
  TaskFacade,
} from "../application/interfaces.ts";
import type { ConcreteModelRef } from "../domain/definition/model.ts";
import { DEFAULT_SESSION_PROFILE, type RootRunInput } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { AgentTool } from "../ports/agent-session-backend.ts";
import type { DiagnosticLog } from "../ports/diagnostic-log.ts";
import {
  createDefinitionRuntime,
  createExecutionServices,
  createPiEventBridge,
  createRuntimeInfrastructure,
  type PhenixHostServices,
} from "./runtime-assembly.ts";

export type { PhenixHostServices } from "./runtime-assembly.ts";

export interface PhenixRuntime {
  readonly execution: ExecutionFacade;
  readonly dynamicWorkflows: DynamicWorkflowExecutionService;
  readonly attention: AttentionFacade;
  readonly profiles: SessionProfileFacade;
  readonly tasks: TaskFacade;
  readonly catalog: CatalogFacade;
  readonly queries: QueryFacade;
  readonly events: OrderedDomainEventBus;
  readonly diagnostics: DiagnosticLog;
  startRoot(input: {
    readonly id: RunId;
    readonly session: RootRunInput;
    readonly model?: ConcreteModelRef;
  }): Promise<void>;
  rootTools(rootRunId: RunId): Promise<readonly AgentTool[]>;
  setRootNotifier(listener: ((message: string) => void | Promise<void>) | undefined): void;
  amendRootInput(rootRunId: RunId, text: string): Promise<void>;
  observeRootModel(rootRunId: RunId, model: ConcreteModelRef): Promise<void>;
  sequence(rootRunId: RunId): number;
  ledgerPath(rootRunId: RunId): string | undefined;
  shutdown(rootRunId: RunId): Promise<void>;
}

export async function createPhenixRuntime(host: PhenixHostServices): Promise<PhenixRuntime> {
  const infrastructure = createRuntimeInfrastructure(host);
  const definitionRuntime = createDefinitionRuntime(infrastructure.operations);
  let activeRootRunId: RunId | undefined;
  let rootNotifier: ((message: string) => void | Promise<void>) | undefined;

  const services = createExecutionServices({
    host,
    infrastructure,
    definitionRuntime,
    currentProfile: async () =>
      activeRootRunId ? infrastructure.profiles.current(activeRootRunId) : DEFAULT_SESSION_PROFILE,
    notifyRoot: (message) => rootNotifier?.(message),
  });
  const unsubscribePiBridge = createPiEventBridge(host.piEventBus, infrastructure.events);

  return {
    execution: services.execution,
    dynamicWorkflows: services.dynamicWorkflows,
    attention: services.attention,
    profiles: infrastructure.profiles,
    tasks: services.tasks,
    catalog: services.catalog,
    queries: services.queries,
    events: infrastructure.events,
    diagnostics: infrastructure.diagnostics,
    async startRoot(input) {
      activeRootRunId = input.id;
      await infrastructure.diagnostics.record({
        rootRunId: input.id,
        runId: input.id,
        severity: "info",
        scope: "runtime.session.starting",
        message: "Phenix root session is starting",
        fields: {
          sessionId: input.session.sessionId,
          sessionFile: input.session.sessionFile,
          cwd: input.session.cwd,
          model: input.model,
        },
      });
      await services.execution.initializeRoot(input);
      await services.dynamicWorkflows.restoreRoot(input.id);
      await services.execution.recoverNonterminal(input.id);
      await services.attention.recover(input.id);
      await infrastructure.events.drain();
      await infrastructure.diagnostics.record({
        rootRunId: input.id,
        runId: input.id,
        severity: "info",
        scope: "runtime.session.started",
        message: "Phenix root session started",
        fields: { sequence: infrastructure.store.sequence(input.id) },
      });
    },
    rootTools: (rootRunId) => services.tools.forRun(rootRunId),
    setRootNotifier(listener) {
      rootNotifier = listener;
    },
    amendRootInput: (rootRunId, text) => services.execution.amendRootInput(rootRunId, text),
    observeRootModel: (rootRunId, model) => services.execution.observeRootModel(rootRunId, model),
    sequence: (rootRunId) => infrastructure.store.sequence(rootRunId),
    ledgerPath: (rootRunId) =>
      infrastructure.ledger instanceof JsonlRunLedger
        ? infrastructure.ledger.pathFor(rootRunId)
        : undefined,
    async shutdown(rootRunId) {
      rootNotifier = undefined;
      await infrastructure.diagnostics.record({
        rootRunId,
        runId: rootRunId,
        severity: "info",
        scope: "runtime.session.shutdown_started",
        message: "Phenix root session shutdown started",
      });
      await services.execution.shutdown(rootRunId);
      await services.attention.shutdown();
      await services.workflows.shutdown();
      await services.agents.shutdown();
      await infrastructure.events.drain();
      await services.checkpoints.shutdown();
      services.supervision.shutdown();
      await infrastructure.diagnostics.record({
        rootRunId,
        runId: rootRunId,
        severity: "info",
        scope: "runtime.session.shutdown_completed",
        message: "Phenix root session shutdown completed",
        fields: { sequence: infrastructure.store.sequence(rootRunId) },
      });
      await infrastructure.diagnostics.drain();
      if (activeRootRunId === rootRunId) activeRootRunId = undefined;
      unsubscribePiBridge();
      infrastructure.unsubscribeDiagnostics();
    },
  };
}
