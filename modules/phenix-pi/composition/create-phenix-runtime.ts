import { randomUUID } from "node:crypto";
import path from "node:path";

import type { EventBus, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { JsonlDiagnosticLog } from "../adapters/persistence/jsonl-diagnostic-log.ts";
import { JsonlRunLedger } from "../adapters/persistence/jsonl-run-ledger.ts";
import { PiSdkAgentSessionBackend } from "../adapters/pi-sdk/agent-session-backend.ts";
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
import { ExecutionFacadeImpl } from "../application/execution-facade.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import type {
  AttentionFacade,
  CatalogFacade,
  ExecutionFacade,
  QueryFacade,
  SessionProfileFacade,
  TaskFacade,
} from "../application/interfaces.ts";
import { SessionInvocationPolicy } from "../application/invocation-policy.ts";
import { formatPresentationNotice, isPresentationFact } from "../application/presentation.ts";
import { ProfileAwareModelResolver } from "../application/profile-aware-model-resolver.ts";
import { QueryFacadeImpl } from "../application/query-facade.ts";
import { SessionProfileFacadeImpl } from "../application/session-profile-facade.ts";
import { TaskFacadeImpl } from "../application/task-facade.ts";
import { WorkflowProcessManager } from "../application/workflow-process-manager.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { ROOT_DISPATCH_DEFINITION_IDS, ROOT_INTERNAL_DEFINITION_IDS } from "../definitions/ids.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import type { ConcreteModelRef } from "../domain/definition/model.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import { DEFAULT_SESSION_PROFILE, type RootRunInput } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { AgentTool } from "../ports/agent-session-backend.ts";
import { type IdGenerator, systemClock } from "../ports/clock.ts";
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

export interface PhenixRuntime {
  readonly execution: ExecutionFacade;
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
  const ids = host.ids ?? new CryptoIdGenerator();
  const stateDir = host.stateDir ?? path.join(host.cwd, ".phenix-agent-state");
  const diagnostics = host.diagnostics ?? new JsonlDiagnosticLog(stateDir);
  const events = new OrderedDomainEventBus({
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
  const ledger = host.ledger ?? new JsonlRunLedger(stateDir);
  const store = new ExecutionStore({ ledger, events, clock: systemClock, ids });
  const unsubscribeDiagnostics = events.subscribe((event) => logDomainEvent(diagnostics, event));
  const profiles = new SessionProfileFacadeImpl(store);
  const operations = new ProcessLocalOperationRunner();
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const definitions = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions]) {
    definitions.register(definition);
  }
  definitions.seal(functions, operations);

  let activeRootRunId: RunId | undefined;
  let rootNotifier: ((message: string) => void | Promise<void>) | undefined;
  const baseResolver = new PhenixModelResolver(
    new PiModelInventory(host.modelRegistry),
    host.routingPolicy,
  );
  const resolver = new ProfileAwareModelResolver(baseResolver, async () => {
    return activeRootRunId ? profiles.current(activeRootRunId) : DEFAULT_SESSION_PROFILE;
  });
  const execution = new ExecutionFacadeImpl({
    catalog: definitions,
    store,
    models: resolver,
    ids,
    clock: systemClock,
    rootInvokableDefinitions: [...ROOT_DISPATCH_DEFINITION_IDS, ...ROOT_INTERNAL_DEFINITION_IDS],
  });
  const tasks = new TaskFacadeImpl({
    store,
    catalog: definitions,
    clock: systemClock,
    ids,
  });
  const catalog = new CatalogFacadeImpl(definitions, store);
  const invocationPolicy = new SessionInvocationPolicy({ store, catalog: definitions });
  const dispatch = new DispatchService({
    execution,
    catalog,
    store,
    invocationPolicy,
  });
  const tools = new FacadeAgentToolFactory({
    execution,
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
  });
  const agents = new AgentExecutor({
    backend,
    controller: execution,
    tools,
    store,
    cwd: host.cwd,
    clock: systemClock,
  });
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
    notifyRoot: (message) => rootNotifier?.(message),
  });

  const unsubscribeNotifications = events.subscribe(async (event) => {
    const run = store.projection.runs.get(event.runId);
    if (!run) return;
    if (event.type === "run.fact.recorded" && isPresentationFact(event.data)) {
      await rootNotifier?.(formatPresentationNotice(run.id, event.data));
      return;
    }
    const retryOf = run.compiled.invocation.retryOf;
    if (event.type === "run.created" && retryOf) {
      const original = store.projection.runs.get(retryOf);
      await rootNotifier?.(summarizeRetryStart(run, original));
      return;
    }
    if (!isTerminalEvent(event.type) || !run.parentId) return;
    const parent = store.projection.runs.get(run.parentId);
    if (!parent) return;
    const summary = summarizeTerminal(run.outcome, run.id, retryOf);
    const failed = run.outcome?.status === "failure";
    if (
      failed ||
      retryOf ||
      (run.compiled.invocation.wait === "background" && parent.kind === "root")
    ) {
      await rootNotifier?.(summary);
    }
    if (parent.kind === "agent" && !isTerminalRunState(parent.state)) {
      if (failed) {
        await execution.notify(
          parent.id,
          `${summary} Inspect the failure report, inform the user, and decide whether to retry with phenix_handle, choose a different route, ask for user input, or stop.`,
        );
      } else if (run.compiled.invocation.wait === "background") {
        await execution.notify(parent.id, summary);
      }
    }
  });

  const unsubscribePiBridge = host.piEventBus
    ? events.subscribe((event) => {
        host.piEventBus?.emit("phenix:domain-event", event);
      })
    : () => undefined;

  return {
    execution,
    attention,
    profiles,
    tasks,
    catalog,
    queries,
    events,
    diagnostics,
    async startRoot(input) {
      activeRootRunId = input.id;
      await diagnostics.record({
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
      await execution.initializeRoot(input);
      await execution.recoverNonterminal(input.id);
      await attention.recover(input.id);
      await events.drain();
      await diagnostics.record({
        rootRunId: input.id,
        runId: input.id,
        severity: "info",
        scope: "runtime.session.started",
        message: "Phenix root session started",
        fields: { sequence: store.sequence(input.id) },
      });
    },
    rootTools: (rootRunId) => tools.forRun(rootRunId),
    setRootNotifier(listener) {
      rootNotifier = listener;
    },
    amendRootInput: (rootRunId, text) => execution.amendRootInput(rootRunId, text),
    observeRootModel: (rootRunId, model) => execution.observeRootModel(rootRunId, model),
    sequence: (rootRunId) => store.sequence(rootRunId),
    ledgerPath: (rootRunId) =>
      ledger instanceof JsonlRunLedger ? ledger.pathFor(rootRunId) : undefined,
    async shutdown(rootRunId) {
      rootNotifier = undefined;
      await diagnostics.record({
        rootRunId,
        runId: rootRunId,
        severity: "info",
        scope: "runtime.session.shutdown_started",
        message: "Phenix root session shutdown started",
      });
      await execution.shutdown(rootRunId);
      await attention.shutdown();
      await workflows.shutdown();
      await agents.shutdown();
      await events.drain();
      await diagnostics.record({
        rootRunId,
        runId: rootRunId,
        severity: "info",
        scope: "runtime.session.shutdown_completed",
        message: "Phenix root session shutdown completed",
        fields: { sequence: store.sequence(rootRunId) },
      });
      await diagnostics.drain();
      if (activeRootRunId === rootRunId) activeRootRunId = undefined;
      unsubscribeNotifications();
      unsubscribePiBridge();
      unsubscribeDiagnostics();
    },
  };
}

class CryptoIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }
}

function isTerminalEvent(type: string): boolean {
  return ["run.completed", "run.failed", "run.cancelled", "run.orphaned"].includes(type);
}

function summarizeRetryStart(
  retry: {
    readonly id: RunId;
    readonly compiled: { readonly tools: readonly string[]; readonly limits: object };
  },
  original:
    | {
        readonly id: RunId;
        readonly compiled: { readonly tools: readonly string[]; readonly limits: object };
      }
    | undefined,
): string {
  const originalTools = new Set(original?.compiled.tools ?? []);
  const addedTools = retry.compiled.tools.filter((tool) => !originalTools.has(tool));
  const retryLimits = retry.compiled.limits as Readonly<Record<string, unknown>>;
  const originalLimits = original?.compiled.limits as Readonly<Record<string, unknown>> | undefined;
  const changedLimits = originalLimits
    ? Object.fromEntries(
        [...new Set([...Object.keys(originalLimits), ...Object.keys(retryLimits)])]
          .filter((key) => retryLimits[key] !== originalLimits[key])
          .map((key) => [key, retryLimits[key] ?? null]),
      )
    : retryLimits;
  const tools = addedTools.length > 0 ? ` Added tools: ${addedTools.join(", ")}.` : "";
  const limits =
    Object.keys(changedLimits).length > 0
      ? ` Changed limits: ${JSON.stringify(changedLimits)}.`
      : "";
  return `Recovery run ${retry.id} started for failed run ${original?.id ?? "unknown"}.${tools}${limits} The original outcome remains immutable.`;
}

function summarizeTerminal(outcome: unknown, runId: RunId, retryOf?: RunId): string {
  const value = outcome as
    | { readonly status: "success"; readonly value: unknown }
    | {
        readonly status: "failure";
        readonly failure: {
          readonly code: string;
          readonly message: string;
          readonly retryable: boolean;
          readonly causeRunId?: RunId;
          readonly details?: {
            readonly category?: string;
            readonly requestedTools?: readonly string[];
            readonly suggestedLimits?: unknown;
          };
        };
      }
    | { readonly status: "cancelled"; readonly reason: string }
    | undefined;
  const prefix = retryOf ? `Recovery run ${runId} for ${retryOf}` : `Run ${runId}`;
  if (!value) return `${prefix} reached a terminal state.`;
  if (value.status === "failure") {
    const cause = value.failure.causeRunId ? ` Cause: ${value.failure.causeRunId}.` : "";
    const category = value.failure.details?.category
      ? ` Category: ${value.failure.details.category}.`
      : "";
    const requestedTools = value.failure.details?.requestedTools?.length
      ? ` Requested tools: ${value.failure.details.requestedTools.join(", ")}.`
      : "";
    const suggestedLimits = value.failure.details?.suggestedLimits
      ? ` Suggested limits: ${JSON.stringify(value.failure.details.suggestedLimits)}.`
      : "";
    const recovery = value.failure.retryable
      ? " A bounded retry may be appropriate after inspecting the report."
      : " The failure is marked non-retryable; choose another route or ask the user before forcing recovery.";
    const punctuation = /[.!?]$/.test(value.failure.message) ? "" : ".";
    return `${prefix} failed [${value.failure.code}]: ${value.failure.message}${punctuation}${cause}${category}${requestedTools}${suggestedLimits}${recovery}`;
  }
  if (value.status === "cancelled") return `${prefix} was cancelled: ${value.reason}`;
  const summary =
    typeof value.value === "object" &&
    value.value !== null &&
    typeof (value.value as { summary?: unknown }).summary === "string"
      ? (value.value as { summary: string }).summary
      : "completed successfully";
  return `${prefix} completed: ${summary}. Use phenix_handle to inspect the full outcome.`;
}
