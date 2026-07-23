import type {
  AgentDefinition,
  AnyDefinition,
  CapabilitySet,
  WorkflowDefinition,
} from "../domain/definition/definition.ts";
import type { ConcreteModelRef, ResolvedModel } from "../domain/definition/model.ts";
import type { PendingDomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import {
  type CompiledRunSpec,
  ROOT_CAPABILITIES,
  ROOT_DEFINITION_ID,
  type RootRunInput,
  type RunRecord,
  type RunSnapshot,
  type StartRun,
  type WorkflowCausation,
} from "../domain/run/model.ts";
import {
  cancelled,
  type DefinitionId,
  type Failure,
  failed,
  type Outcome,
  type RunId,
  success,
} from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { ModelResolver } from "../ports/model-resolver.ts";
import type { DefinitionCatalog } from "./catalog.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { ExecutionFacade, RunHandle } from "./interfaces.ts";

export interface StartImplementationCommand {
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly parentId: RunId;
  readonly definition: AnyDefinition;
  readonly input: unknown;
  readonly resolvedModel?: ResolvedModel;
}

export interface RunImplementation {
  start(command: StartImplementationCommand): Promise<void>;
  recover?(command: StartImplementationCommand, record: RunRecord): Promise<boolean>;
  send?(runId: RunId, message: string, delivery: "normal" | "nextTurn"): Promise<void>;
  cancel?(runId: RunId, reason: string): Promise<void>;
  dispose?(runId: RunId): Promise<void>;
}

export interface InternalStartRun<I, O> extends StartRun<I, O> {
  readonly causation?: WorkflowCausation;
  readonly trustedWorkflowInvocation?: boolean;
}

export interface ChildInvoker {
  start<I, O>(request: InternalStartRun<I, O>): Promise<RunHandle<O>>;
  cancel(runId: RunId, reason: string): Promise<void>;
}

export interface RunController {
  state(runId: RunId): RunRecord;
  transition(runId: RunId, to: RunRecord["state"]): Promise<void>;
  bindPi(runId: RunId, pi: NonNullable<RunRecord["pi"]>): Promise<void>;
  cycleStarted(runId: RunId, number: number): Promise<void>;
  cycleSettled(runId: RunId, number: number): Promise<void>;
  turnEnded(runId: RunId): Promise<number>;
  toolStarted(runId: RunId, toolName: string): Promise<number>;
  submitOutput(runId: RunId, output: unknown): Promise<void>;
  rejectOutput(runId: RunId, issues: unknown): Promise<void>;
  complete(runId: RunId, output: unknown): Promise<void>;
  fail(runId: RunId, failure: Failure): Promise<void>;
  orphan(runId: RunId, reason: string): Promise<void>;
  activeAttachedChildren(runId: RunId): readonly RunRecord[];
  isTerminating(runId: RunId): boolean;
}

export class ExecutionFacadeImpl implements ExecutionFacade, RunController {
  private readonly catalog: DefinitionCatalog;
  private readonly store: ExecutionStore;
  private readonly models: ModelResolver;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly rootInvokableDefinitions: readonly DefinitionId[];
  private readonly implementations = new Map<"agent" | "workflow", RunImplementation>();
  private readonly terminating = new Set<RunId>();
  private sealed = false;

  constructor(input: {
    readonly catalog: DefinitionCatalog;
    readonly store: ExecutionStore;
    readonly models: ModelResolver;
    readonly ids: IdGenerator;
    readonly clock: Clock;
    readonly rootInvokableDefinitions?: readonly DefinitionId[];
  }) {
    this.catalog = input.catalog;
    this.store = input.store;
    this.models = input.models;
    this.ids = input.ids;
    this.clock = input.clock;
    this.rootInvokableDefinitions =
      input.rootInvokableDefinitions ?? this.catalog.list().map((definition) => definition.id);
  }

  registerImplementation(kind: "agent" | "workflow", implementation: RunImplementation): void {
    if (this.sealed) throw new Error(`Execution runtime is sealed`);
    if (this.implementations.has(kind))
      throw new Error(`Implementation already registered: ${kind}`);
    this.implementations.set(kind, implementation);
  }

  seal(): void {
    if (!this.implementations.has("agent") || !this.implementations.has("workflow")) {
      throw new Error(`Both agent and workflow implementations must be registered`);
    }
    this.sealed = true;
  }

  childInvoker(): ChildInvoker {
    return {
      start: <I, O>(request: InternalStartRun<I, O>) => this.startInternal(request),
      cancel: (runId, reason) => this.cancel(runId, reason),
    };
  }

  async initializeRoot(input: {
    readonly id: RunId;
    readonly session: RootRunInput;
    readonly model?: ConcreteModelRef;
  }): Promise<RunRecord> {
    await this.store.load(input.id);
    const existing = this.store.projection.runs.get(input.id);
    if (existing) {
      if (existing.kind !== "root") throw new Error(`${input.id} is not a root run`);
      if (
        existing.pi?.sessionId !== input.session.sessionId ||
        existing.pi?.sessionFile !== input.session.sessionFile
      ) {
        await this.bindPi(input.id, {
          sessionId: input.session.sessionId,
          ...(input.session.sessionFile ? { sessionFile: input.session.sessionFile } : {}),
        });
      }
      if (input.model) await this.observeRootModel(input.id, input.model);
      return this.store.projection.requireRun(input.id);
    }

    const capabilities: CapabilitySet = {
      ...ROOT_CAPABILITIES,
      invokableDefinitions: this.rootInvokableDefinitions,
    };
    const compiled: CompiledRunSpec = {
      definitionId: ROOT_DEFINITION_ID,
      input: input.session,
      outputSchemaId: "root.outcome",
      tools: ["phenix_dispatch", "phenix_handle", "phenix_tasks"],
      limits: { timeoutMs: 0 },
      capabilities,
      invocation: { wait: "background" },
    };
    const record: Omit<RunRecord, "revision" | "state"> = {
      id: input.id,
      kind: "root",
      definitionId: ROOT_DEFINITION_ID,
      input: input.session,
      outputSchemaId: compiled.outputSchemaId,
      requestedAt: this.clock.now(),
      ownership: "attached",
      compiled,
      pi: {
        sessionId: input.session.sessionId,
        ...(input.session.sessionFile ? { sessionFile: input.session.sessionFile } : {}),
      },
    };
    await this.store.commit(input.id, [
      { runId: input.id, type: "run.created", data: { record } },
      {
        runId: input.id,
        type: "run.state.changed",
        data: { from: "created", to: "running" },
      },
      ...(input.model
        ? [
            {
              runId: input.id,
              type: "run.model.observed",
              data: { model: input.model },
            } satisfies PendingDomainEvent,
          ]
        : []),
    ]);
    return this.store.projection.requireRun(input.id);
  }

  async amendRootInput(rootRunId: RunId, text: string): Promise<void> {
    const root = this.store.projection.requireRun(rootRunId);
    if (root.kind !== "root") throw new Error(`${rootRunId} is not a root run`);
    await this.store.commit(rootRunId, [
      { runId: rootRunId, type: "run.input.amended", data: { text } },
    ]);
  }

  async observeRootModel(rootRunId: RunId, model: ConcreteModelRef): Promise<void> {
    await this.store.commit(rootRunId, [
      { runId: rootRunId, type: "run.model.observed", data: { model } },
    ]);
  }

  start<I, O>(request: StartRun<I, O>): Promise<RunHandle<O>> {
    return this.startInternal(request);
  }

  async startInternal<I, O>(request: InternalStartRun<I, O>): Promise<RunHandle<O>> {
    if (!this.sealed) throw new Error(`Execution runtime is not sealed`);
    const parent = this.store.projection.requireRun(request.parentId);
    if (
      isTerminalRunState(parent.state) ||
      parent.state === "completing" ||
      this.terminating.has(parent.id)
    ) {
      throw new Error(
        `Cannot start a child from terminating or ${parent.state} parent ${parent.id}`,
      );
    }
    const rootRunId = this.store.projection.rootOf(parent.id);
    const definition = this.catalog.get(request.definition) as AnyDefinition;
    const validation = definition.input.validate(request.input);
    if (!validation.ok) {
      throw new Error(
        `Input for ${definition.id} is invalid: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }

    this.authorize(parent, definition, request);
    const id = this.ids.next("run") as RunId;
    let resolvedModel: ResolvedModel | undefined;
    let modelFailure: Failure | undefined;
    if (definition.kind === "agent") {
      try {
        resolvedModel = await this.resolveModel(definition, parent.definitionId);
      } catch (error) {
        modelFailure = {
          code: "model_unavailable",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        };
      }
    }
    const currentParent = this.store.projection.requireRun(request.parentId);
    if (
      isTerminalRunState(currentParent.state) ||
      currentParent.state === "completing" ||
      this.terminating.has(currentParent.id)
    ) {
      throw new Error(
        `Cannot start a child from terminating or ${currentParent.state} parent ${currentParent.id}`,
      );
    }
    const capabilityOverride = this.authorize(currentParent, definition, request);
    const capabilities = this.capabilitiesFor(
      definition,
      currentParent.compiled.capabilities,
      capabilityOverride,
    );
    const compiled = this.compile(
      definition,
      validation.value,
      capabilities,
      request.wait,
      request.causation,
    );
    const record: Omit<RunRecord, "revision" | "state"> = {
      id,
      parentId: currentParent.id,
      kind: definition.kind,
      definitionId: definition.id,
      input: validation.value,
      outputSchemaId: definition.output.id,
      requestedAt: this.clock.now(),
      ownership: "attached",
      compiled,
    };
    const createEvents: PendingDomainEvent[] = [
      {
        runId: id,
        parentRunId: currentParent.id,
        type: "run.created",
        data: { record },
      },
      ...(resolvedModel
        ? [
            {
              runId: id,
              parentRunId: currentParent.id,
              type: "run.model.resolved",
              data: { resolved: resolvedModel },
            },
          ]
        : []),
    ];
    await this.store.commit(rootRunId, createEvents);

    if (modelFailure) {
      await this.fail(id, modelFailure);
      return this.handle<O>(id);
    }

    if (request.lifetime === "detached-to-root") {
      await this.reparent(id, rootRunId);
    }

    const implementation = this.requireImplementation(definition.kind);
    try {
      await implementation.start({
        rootRunId,
        runId: id,
        parentId: this.store.projection.requireRun(id).parentId ?? currentParent.id,
        definition,
        input: validation.value,
        ...(resolvedModel ? { resolvedModel } : {}),
      });
    } catch (error) {
      await this.fail(id, {
        code: "backend_start_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    }

    return this.handle<O>(id);
  }

  async inspect(runId: RunId): Promise<RunSnapshot> {
    const run = this.store.projection.requireRun(runId);
    return {
      ...run,
      activeChildren: this.activeAttachedChildren(runId).map((child) => child.id),
    };
  }

  async await<O>(runId: RunId, signal?: AbortSignal): Promise<Outcome<O>> {
    const current = this.store.projection.requireRun(runId);
    if (current.outcome) return current.outcome as Outcome<O>;
    if (signal?.aborted) throw abortError(signal);

    return new Promise<Outcome<O>>((resolve, reject) => {
      let unsubscribe: () => void = () => undefined;
      const onAbort = (): void => {
        unsubscribe();
        reject(abortError(signal));
      };
      unsubscribe = this.store.events.subscribe((event) => {
        if (event.runId !== runId || !isTerminalEvent(event.type)) return;
        const outcome = this.store.projection.requireRun(runId).outcome;
        if (!outcome) return;
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        resolve(outcome as Outcome<O>);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async send(runId: RunId, message: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state)) throw new Error(`Run ${runId} is terminal`);
    const implementation = this.requireImplementation(run.kind);
    if (!implementation.send) throw new Error(`${run.kind} runs do not accept messages`);
    await implementation.send(runId, message, "normal");
  }

  async notify(runId: RunId, message: string): Promise<void> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state)) return;
    const implementation = this.requireImplementation(run.kind);
    await implementation.send?.(runId, message, "nextTurn");
  }

  async cancel(runId: RunId, reason: string): Promise<void> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) return;
    this.terminating.add(runId);
    try {
      await Promise.all(
        this.activeAttachedChildren(runId).map((child) => this.cancel(child.id, reason)),
      );
      let backendLost = false;
      try {
        if (run.kind !== "root") {
          await this.implementations.get(run.kind)?.cancel?.(runId, reason);
        }
      } catch {
        backendLost = true;
      }
      await this.terminateWhenQuiescent(
        runId,
        (child) => this.cancel(child.id, reason),
        backendLost
          ? {
              runId,
              type: "run.orphaned",
              data: {
                outcome: failed({
                  code: "orphaned",
                  message: `Cancellation backend was lost: ${reason}`,
                  retryable: false,
                }),
              },
            }
          : {
              runId,
              type: "run.cancelled",
              data: { outcome: cancelled(reason) },
            },
      );
    } finally {
      this.terminating.delete(runId);
    }
  }

  async reparent(runId: RunId, newParentId: RunId): Promise<void> {
    const run = this.store.projection.requireRun(runId);
    if (!run.parentId) throw new Error(`The root run cannot be reparented`);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) {
      throw new Error(`A terminating or terminal run cannot be reparented`);
    }
    const newParent = this.store.projection.requireRun(newParentId);
    const rootRunId = this.store.projection.rootOf(runId);
    if (this.store.projection.rootOf(newParent.id) !== rootRunId || newParent.kind !== "root") {
      throw new Error(`Detached runs must be reparented to their root supervisor`);
    }
    await this.store.commit(rootRunId, [
      {
        runId,
        type: "run.reparented",
        data: {
          previousParentId: run.parentId,
          newParentId,
          ownership: "detached",
        },
      },
    ]);
  }

  state(runId: RunId): RunRecord {
    return this.store.projection.requireRun(runId);
  }

  async transition(runId: RunId, to: RunRecord["state"]): Promise<void> {
    const current = this.store.projection.requireRun(runId);
    if (current.state === to || isTerminalRunState(current.state) || this.terminating.has(runId)) {
      return;
    }
    const root = this.store.projection.rootOf(runId);
    await this.store.commit(root, [
      {
        runId,
        type: "run.state.changed",
        data: { from: current.state, to },
      },
    ]);
  }

  async bindPi(runId: RunId, pi: NonNullable<RunRecord["pi"]>): Promise<void> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) return;
    const root = this.store.projection.rootOf(runId);
    await this.store.commit(root, [{ runId, type: "run.pi.bound", data: { pi } }]);
  }

  async cycleStarted(runId: RunId, number: number): Promise<void> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) return;
    const root = this.store.projection.rootOf(runId);
    await this.store.commit(root, [{ runId, type: "run.cycle.started", data: { number } }]);
  }

  async cycleSettled(runId: RunId, number: number): Promise<void> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) return;
    const root = this.store.projection.rootOf(runId);
    await this.store.commit(root, [{ runId, type: "run.cycle.settled", data: { number } }]);
  }

  async turnEnded(runId: RunId): Promise<number> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) {
      return this.store.projection.turnCounts.get(runId) ?? 0;
    }
    await this.store.commit(this.store.projection.rootOf(runId), [
      { runId, type: "run.turn.ended", data: {} },
    ]);
    return this.store.projection.turnCounts.get(runId) ?? 0;
  }

  async toolStarted(runId: RunId, toolName: string): Promise<number> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) {
      return this.store.projection.toolCallCounts.get(runId) ?? 0;
    }
    await this.store.commit(this.store.projection.rootOf(runId), [
      { runId, type: "run.tool.started", data: { toolName } },
    ]);
    return this.store.projection.toolCallCounts.get(runId) ?? 0;
  }

  async submitOutput(runId: RunId, output: unknown): Promise<void> {
    const current = this.store.projection.requireRun(runId);
    if (isTerminalRunState(current.state) || this.terminating.has(runId)) {
      throw new Error(`Run ${runId} cannot accept output while terminating or terminal`);
    }
    if (this.store.projection.submittedOutputs.has(runId)) {
      throw new Error(`Run ${runId} already submitted an immutable output`);
    }
    const root = this.store.projection.rootOf(runId);
    const run = this.store.projection.requireRun(runId);
    await this.store.commit(root, [
      { runId, type: "run.output.submitted", data: { output } },
      ...(run.state === "running" || run.state === "waiting"
        ? [
            {
              runId,
              type: "run.state.changed",
              data: { from: run.state, to: "completing" },
            } satisfies PendingDomainEvent,
          ]
        : []),
    ]);
  }

  async rejectOutput(runId: RunId, issues: unknown): Promise<void> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) return;
    const root = this.store.projection.rootOf(runId);
    await this.store.commit(root, [{ runId, type: "run.output.rejected", data: { issues } }]);
  }

  async complete(runId: RunId, output: unknown): Promise<void> {
    let run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) return;
    if (this.activeAttachedChildren(runId).length > 0) {
      throw new Error(`Run ${runId} cannot complete while attached children are active`);
    }
    if (run.kind !== "root") {
      const definition = this.catalog.require(run.definitionId);
      const validation = definition.output.validate(output);
      if (!validation.ok) {
        await this.fail(runId, {
          code: "output_invalid",
          message: validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
          retryable: false,
          details: validation.issues,
        });
        return;
      }
      output = validation.value;
    }
    if (run.state !== "completing") {
      await this.transition(runId, "completing");
      run = this.store.projection.requireRun(runId);
    }
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) return;
    if (this.activeAttachedChildren(runId).length > 0) return;
    const root = this.store.projection.rootOf(runId);
    await this.store.commit(root, [
      { runId, type: "run.completed", data: { outcome: success(output) } },
    ]);
    if (run.kind !== "root") {
      try {
        await this.implementations.get(run.kind)?.dispose?.(runId);
      } catch {
        // A committed semantic outcome remains authoritative if cleanup fails.
      }
    }
  }

  async fail(runId: RunId, failure: Failure): Promise<void> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) return;
    this.terminating.add(runId);
    const childReason = `Parent ${runId} failed: ${failure.message}`;
    try {
      await Promise.all(
        this.activeAttachedChildren(runId).map((child) => this.cancel(child.id, childReason)),
      );
      try {
        if (run.kind !== "root") {
          await this.implementations.get(run.kind)?.cancel?.(runId, failure.message);
        }
      } catch {
        // The failure remains authoritative even if backend cleanup fails.
      }
      await this.terminateWhenQuiescent(runId, (child) => this.cancel(child.id, childReason), {
        runId,
        type: "run.failed",
        data: { outcome: failed(failure) },
      });
    } finally {
      this.terminating.delete(runId);
    }
  }

  async orphan(runId: RunId, reason: string): Promise<void> {
    const run = this.store.projection.requireRun(runId);
    if (isTerminalRunState(run.state) || this.terminating.has(runId)) return;
    this.terminating.add(runId);
    try {
      await Promise.all(
        this.activeAttachedChildren(runId).map((child) => this.orphan(child.id, reason)),
      );
      try {
        if (run.kind !== "root") {
          await this.implementations.get(run.kind)?.cancel?.(runId, reason);
        }
      } catch {
        // The backend is already considered lost.
      }
      await this.terminateWhenQuiescent(runId, (child) => this.orphan(child.id, reason), {
        runId,
        type: "run.orphaned",
        data: {
          outcome: failed({
            code: "orphaned",
            message: reason,
            retryable: false,
          }),
        },
      });
    } finally {
      this.terminating.delete(runId);
    }
  }

  private async terminateWhenQuiescent(
    runId: RunId,
    terminateChild: (child: RunRecord) => Promise<void>,
    terminalEvent: PendingDomainEvent,
  ): Promise<void> {
    while (true) {
      const current = this.store.projection.requireRun(runId);
      if (isTerminalRunState(current.state)) return;
      const children = this.activeAttachedChildren(runId);
      if (children.length > 0) {
        await Promise.all(
          children.map(async (child) => {
            await terminateChild(child);
            if (!isTerminalRunState(this.store.projection.requireRun(child.id).state)) {
              await this.await(child.id);
            }
          }),
        );
        continue;
      }
      try {
        await this.store.commit(this.store.projection.rootOf(runId), [terminalEvent]);
        return;
      } catch (error) {
        const latest = this.store.projection.requireRun(runId);
        if (isTerminalRunState(latest.state)) return;
        if (this.activeAttachedChildren(runId).length === 0) throw error;
      }
    }
  }

  activeAttachedChildren(runId: RunId): readonly RunRecord[] {
    const parent = this.store.projection.requireRun(runId);
    return this.store.projection
      .childrenOf(runId)
      .filter(
        (child) =>
          (child.ownership === "attached" || parent.kind === "root") &&
          !isTerminalRunState(child.state),
      );
  }

  isTerminating(runId: RunId): boolean {
    return this.terminating.has(runId);
  }

  async recoverNonterminal(rootRunId: RunId): Promise<void> {
    const runs = [...this.store.projection.runs.values()]
      .filter(
        (run) =>
          run.id !== rootRunId &&
          this.store.projection.rootOf(run.id) === rootRunId &&
          !isTerminalRunState(run.state),
      )
      .sort((left, right) => this.depth(right.id) - this.depth(left.id));

    for (const discovered of runs) {
      const run = this.store.projection.requireRun(discovered.id);
      if (isTerminalRunState(run.state)) continue;
      const implementation = this.requireImplementation(run.kind);
      const definition = this.catalog.require(run.definitionId);
      const command: StartImplementationCommand = {
        rootRunId,
        runId: run.id,
        parentId: run.parentId ?? rootRunId,
        definition,
        input: run.input,
        ...(run.resolvedModel ? { resolvedModel: run.resolvedModel } : {}),
      };
      const recovered = await implementation.recover?.(command, run);
      if (!recovered && run.kind === "agent") {
        await this.orphan(run.id, `Agent backend could not be recovered`);
      }
    }
  }

  async shutdown(rootRunId: RunId): Promise<void> {
    const activeAgents = [...this.store.projection.runs.values()]
      .filter(
        (run) =>
          run.kind === "agent" &&
          this.store.projection.rootOf(run.id) === rootRunId &&
          !isTerminalRunState(run.state),
      )
      .sort((left, right) => this.depth(right.id) - this.depth(left.id));
    for (const run of activeAgents) {
      if (
        (this.catalog.require(run.definitionId) as AgentDefinition<unknown, unknown>)
          .persistence === "memory"
      ) {
        await this.orphan(run.id, `In-memory Pi session was lost during root shutdown`);
      } else {
        await this.implementations.get("agent")?.dispose?.(run.id);
      }
    }
    await this.store.events.drain();
  }

  private handle<O>(id: RunId): RunHandle<O> {
    return {
      id,
      snapshot: () => this.inspect(id),
      result: (signal) => this.await<O>(id, signal),
      send: (message, signal) => this.send(id, message, signal),
      cancel: (reason) => this.cancel(id, reason),
      subscribe: (listener) =>
        this.store.events.subscribe((event) => {
          if (event.runId === id) listener(event);
        }),
    };
  }

  private requireImplementation(kind: RunRecord["kind"]): RunImplementation {
    if (kind === "root") throw new Error(`Root runs do not have a child implementation`);
    const implementation = this.implementations.get(kind);
    if (!implementation) throw new Error(`No implementation registered for ${kind}`);
    return implementation;
  }

  private authorize<I, O>(
    parent: RunRecord,
    definition: AnyDefinition,
    request: InternalStartRun<I, O>,
  ): Partial<CapabilitySet> | undefined {
    let capabilities = parent.compiled.capabilities;
    if (parent.kind === "workflow") {
      if (!request.trustedWorkflowInvocation || !request.causation) {
        throw new Error(`Workflow children may only be started by their process manager`);
      }
      const parentDefinition = this.catalog.require(parent.definitionId) as WorkflowDefinition<
        unknown,
        unknown
      >;
      const invocation = parentDefinition.graph.nodes.find(
        (node) => node.kind === "invoke" && node.id === request.causation?.nodeId,
      );
      if (invocation?.kind !== "invoke" || invocation.definition.id !== definition.id) {
        throw new Error(`Definition ${definition.id} is not authorized at workflow node`);
      }
      if (!parent.compiled.capabilities.invokableDefinitions.includes(definition.id)) {
        throw new Error(`Workflow capability scope excludes ${definition.id}`);
      }
      capabilities = {
        invokableDefinitions: [definition.id],
        maxDepth: parent.compiled.capabilities.maxDepth,
        mayDetach: false,
        maySend: false,
        mayCancelChildren: true,
      };
    }

    const invokableDefinitions =
      parent.kind === "root" ? this.rootInvokableDefinitions : capabilities.invokableDefinitions;
    if (!invokableDefinitions.includes(definition.id)) {
      throw new Error(`Parent ${parent.id} cannot invoke ${definition.id}`);
    }
    if (this.depth(parent.id) + 1 > capabilities.maxDepth) {
      throw new Error(`Invocation of ${definition.id} exceeds delegation depth`);
    }
    if (request.lifetime === "detached-to-root" && !capabilities.mayDetach) {
      throw new Error(`Parent ${parent.id} may not detach children`);
    }
    if (parent.kind !== "workflow") return undefined;
    const workflow = this.catalog.require(parent.definitionId) as WorkflowDefinition<
      unknown,
      unknown
    >;
    const invocation = workflow.graph.nodes.find(
      (node) => node.kind === "invoke" && node.id === request.causation?.nodeId,
    );
    return invocation?.kind === "invoke" ? invocation.capabilityOverride : undefined;
  }

  private depth(runId: RunId): number {
    let depth = 0;
    let current = this.store.projection.requireRun(runId);
    while (current.parentId) {
      depth += 1;
      current = this.store.projection.requireRun(current.parentId);
    }
    return depth;
  }

  private capabilitiesFor(
    definition: AnyDefinition,
    parentCapabilities: CapabilitySet,
    override?: Partial<CapabilitySet>,
  ): CapabilitySet {
    const base: CapabilitySet =
      definition.kind === "agent"
        ? {
            ...definition.childCapabilities,
            maxDepth: Math.min(definition.childCapabilities.maxDepth, parentCapabilities.maxDepth),
          }
        : {
            invokableDefinitions: definition.graph.nodes.flatMap((node) =>
              node.kind === "invoke" ? [node.definition.id] : [],
            ),
            maxDepth: parentCapabilities.maxDepth,
            mayDetach: false,
            maySend: false,
            mayCancelChildren: true,
          };
    if (!override) return base;
    const allowed = new Set(override.invokableDefinitions ?? base.invokableDefinitions);
    return {
      invokableDefinitions: base.invokableDefinitions.filter((id) => allowed.has(id)),
      maxDepth: Math.min(base.maxDepth, override.maxDepth ?? base.maxDepth),
      mayDetach: base.mayDetach && (override.mayDetach ?? true),
      maySend: base.maySend && (override.maySend ?? true),
      mayCancelChildren: base.mayCancelChildren && (override.mayCancelChildren ?? true),
    };
  }

  private compile(
    definition: AnyDefinition,
    input: unknown,
    capabilities: CapabilitySet,
    wait: "await" | "background",
    causation?: WorkflowCausation,
  ): CompiledRunSpec {
    if (definition.kind === "agent") {
      return {
        definitionId: definition.id,
        input,
        outputSchemaId: definition.output.id,
        tools: definition.tools.allow,
        contextPolicy: definition.context,
        modelSelector: definition.model,
        limits: definition.limits,
        capabilities,
        invocation: { wait, ...(causation ? { causation } : {}) },
      };
    }
    return {
      definitionId: definition.id,
      input,
      outputSchemaId: definition.output.id,
      tools: [],
      limits: definition.limits,
      capabilities,
      invocation: { wait, ...(causation ? { causation } : {}) },
    };
  }

  private resolveModel(
    definition: AgentDefinition<unknown, unknown>,
    parentDefinitionId: string,
  ): Promise<ResolvedModel> {
    return this.models.resolve(definition.model, {
      definitionId: definition.id,
      parentDefinitionId,
      thinking: definition.thinking,
    });
  }
}

function isTerminalEvent(type: string): boolean {
  return (
    type === "run.completed" ||
    type === "run.failed" ||
    type === "run.cancelled" ||
    type === "run.orphaned"
  );
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "Wait cancelled");
  error.name = "AbortError";
  return error;
}
