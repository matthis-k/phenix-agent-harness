import { randomUUID } from "node:crypto";
import path from "node:path";

import type { EventBus, ModelRegistry } from "@earendil-works/pi-coding-agent";
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
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { CatalogFacadeImpl } from "../application/catalog-facade.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import { ExecutionFacadeImpl } from "../application/execution-facade.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import type {
  CatalogFacade,
  ExecutionFacade,
  QueryFacade,
  SessionProfileFacade,
  TaskFacade,
} from "../application/interfaces.ts";
import { SessionInvocationPolicy } from "../application/invocation-policy.ts";
import { ProfileAwareModelResolver } from "../application/profile-aware-model-resolver.ts";
import { QueryFacadeImpl } from "../application/query-facade.ts";
import { SessionProfileFacadeImpl } from "../application/session-profile-facade.ts";
import { TaskFacadeImpl } from "../application/task-facade.ts";
import { WorkflowProcessManager } from "../application/workflow-process-manager.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import type { ConcreteModelRef } from "../domain/definition/model.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import { DEFAULT_SESSION_PROFILE, type RootRunInput } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { AgentTool } from "../ports/agent-session-backend.ts";
import { type IdGenerator, systemClock } from "../ports/clock.ts";
import type { RunLedger } from "../ports/run-ledger.ts";

export interface PhenixHostServices {
  readonly cwd: string;
  readonly agentDir: string;
  readonly stateDir?: string;
  readonly modelRegistry: ModelRegistry;
  readonly routingPolicy?: RoutingPolicy;
  readonly piEventBus?: EventBus;
  readonly ledger?: RunLedger;
  readonly ids?: IdGenerator;
}

export interface PhenixRuntime {
  readonly execution: ExecutionFacade;
  readonly profiles: SessionProfileFacade;
  readonly tasks: TaskFacade;
  readonly catalog: CatalogFacade;
  readonly queries: QueryFacade;
  readonly events: OrderedDomainEventBus;
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
  const events = new OrderedDomainEventBus();
  const ledger =
    host.ledger ?? new JsonlRunLedger(host.stateDir ?? path.join(host.cwd, ".phenix-agent-state"));
  const store = new ExecutionStore({ ledger, events, clock: systemClock, ids });
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
  });
  const tasks = new TaskFacadeImpl({
    store,
    catalog: definitions,
    clock: systemClock,
    ids,
  });
  const catalog = new CatalogFacadeImpl(definitions, store);
  const invocationPolicy = new SessionInvocationPolicy({ store, catalog: definitions });
  const tools = new FacadeAgentToolFactory({
    execution,
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

  let rootNotifier: ((message: string) => void | Promise<void>) | undefined;
  const unsubscribeNotifications = events.subscribe(async (event) => {
    if (!isTerminalEvent(event.type)) return;
    const run = store.projection.runs.get(event.runId);
    if (run?.compiled.invocation.wait !== "background" || !run.parentId) return;
    const parent = store.projection.runs.get(run.parentId);
    if (!parent) return;
    const summary = summarizeTerminal(run.outcome, run.id);
    if (parent.kind === "root") {
      await rootNotifier?.(summary);
    } else if (parent.kind === "agent" && !isTerminalRunState(parent.state)) {
      await execution.notify(parent.id, summary);
    }
  });

  const unsubscribePiBridge = host.piEventBus
    ? events.subscribe((event) => {
        host.piEventBus?.emit("phenix:domain-event", event);
      })
    : () => undefined;

  return {
    execution,
    profiles,
    tasks,
    catalog,
    queries,
    events,
    async startRoot(input) {
      activeRootRunId = input.id;
      await execution.initializeRoot(input);
      await execution.recoverNonterminal(input.id);
      await events.drain();
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
      await execution.shutdown(rootRunId);
      await workflows.shutdown();
      await agents.shutdown();
      await events.drain();
      if (activeRootRunId === rootRunId) activeRootRunId = undefined;
      unsubscribeNotifications();
      unsubscribePiBridge();
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

function summarizeTerminal(outcome: unknown, runId: RunId): string {
  const value = outcome as
    | { readonly status: "success"; readonly value: unknown }
    | { readonly status: "failure"; readonly failure: { readonly message: string } }
    | { readonly status: "cancelled"; readonly reason: string }
    | undefined;
  if (!value) return `Background run ${runId} reached a terminal state.`;
  if (value.status === "failure") return `Background run ${runId} failed: ${value.failure.message}`;
  if (value.status === "cancelled") return `Background run ${runId} was cancelled: ${value.reason}`;
  const summary =
    typeof value.value === "object" &&
    value.value !== null &&
    typeof (value.value as { summary?: unknown }).summary === "string"
      ? (value.value as { summary: string }).summary
      : "completed successfully";
  return `Background run ${runId} completed: ${summary}. Use phenix_handle to inspect the full outcome.`;
}
