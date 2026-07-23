import type {
  AnyDefinition,
  InvokeNode,
  JoinNode,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "../domain/definition/definition.ts";
import type { DomainEvent, PendingDomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord } from "../domain/run/model.ts";
import type { Failure, Outcome, RunId } from "../domain/shared.ts";
import {
  buildWorkflowGraphState,
  type WorkflowGraphState,
  workflowNode,
} from "../domain/workflow/graph-state.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";
import type { DefinitionCatalog, WorkflowFunctionRegistry } from "./catalog.ts";
import type {
  ChildInvoker,
  RunController,
  RunImplementation,
  StartImplementationCommand,
} from "./execution-facade.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { TaskFacade } from "./interfaces.ts";
import { KeyedSerialExecutor } from "./keyed-serial-executor.ts";

export class WorkflowProcessManager implements RunImplementation {
  private readonly invoker: ChildInvoker;
  private readonly controller: RunController;
  private readonly operations: LocalOperationRunner;
  private readonly store: ExecutionStore;
  private readonly catalog: DefinitionCatalog;
  private readonly functions: WorkflowFunctionRegistry;
  private readonly tasks: TaskFacade;
  private readonly ids: IdGenerator;
  private readonly cwd: string;
  private readonly clock: Clock;
  private readonly serial = new KeyedSerialExecutor<RunId>();
  private readonly timers = new Map<RunId, ReturnType<typeof setTimeout>>();
  private readonly operationControllers = new Map<RunId, Set<AbortController>>();
  private readonly activeOperations = new Map<RunId, Set<Promise<unknown>>>();
  private readonly unsubscribe: () => void;

  constructor(input: {
    readonly invoker: ChildInvoker;
    readonly controller: RunController;
    readonly operations: LocalOperationRunner;
    readonly store: ExecutionStore;
    readonly catalog: DefinitionCatalog;
    readonly functions: WorkflowFunctionRegistry;
    readonly tasks: TaskFacade;
    readonly ids: IdGenerator;
    readonly cwd: string;
    readonly clock: Clock;
  }) {
    this.invoker = input.invoker;
    this.controller = input.controller;
    this.operations = input.operations;
    this.store = input.store;
    this.catalog = input.catalog;
    this.functions = input.functions;
    this.tasks = input.tasks;
    this.ids = input.ids;
    this.cwd = input.cwd;
    this.clock = input.clock;
    this.unsubscribe = this.store.events.subscribe((event) => this.onDomainEvent(event));
  }

  async start(command: StartImplementationCommand): Promise<void> {
    const definition = requireWorkflow(command.definition);
    await this.controller.transition(command.runId, "running");
    if (!this.isActive(command.runId)) return;
    await this.commit(command.runId, [this.entered(command.runId, definition.graph.entry)]);
    this.armTimeout(command.runId, definition);
    await this.serial.run(command.runId, () => this.drive(command.runId));
  }

  async recover(command: StartImplementationCommand, record: RunRecord): Promise<boolean> {
    const definition = requireWorkflow(command.definition);
    this.armTimeout(record.id, definition);
    await this.serial.run(record.id, () => this.drive(record.id));
    return true;
  }

  async cancel(runId: RunId): Promise<void> {
    await this.stopRunResources(runId);
  }

  async dispose(runId: RunId): Promise<void> {
    await this.stopRunResources(runId);
  }

  async shutdown(): Promise<void> {
    this.unsubscribe();
    const active = new Set<RunId>([
      ...this.timers.keys(),
      ...this.operationControllers.keys(),
      ...this.activeOperations.keys(),
    ]);
    await Promise.all([...active].map((runId) => this.stopRunResources(runId)));
  }

  private async onDomainEvent(event: DomainEvent): Promise<void> {
    if (!isTerminalEvent(event.type)) return;
    const child = this.store.projection.runs.get(event.runId);
    if (!child?.parentId) return;
    const parent = this.store.projection.runs.get(child.parentId);
    if (
      parent?.kind !== "workflow" ||
      isTerminalRunState(parent.state) ||
      this.controller.isTerminating(parent.id)
    ) {
      return;
    }
    await this.serial.run(parent.id, () => this.drive(parent.id));
  }

  private async drive(workflowRunId: RunId): Promise<void> {
    while (true) {
      const run = this.store.projection.requireRun(workflowRunId);
      if (isTerminalRunState(run.state) || this.controller.isTerminating(run.id)) return;
      const state = this.loadState(run);
      if (state.nodeRuns > state.definition.limits.maxNodeRuns) {
        await this.controller.fail(workflowRunId, {
          code: "workflow_exhausted",
          message: `Workflow exceeded ${state.definition.limits.maxNodeRuns} node activations`,
          retryable: false,
        });
        return;
      }
      if (state.active.length === 0) {
        await this.controller.fail(workflowRunId, {
          code: "workflow_invalid",
          message: `Workflow has no active or terminal node`,
          retryable: false,
        });
        return;
      }

      let progressed = false;
      for (const activation of state.active) {
        const latestRun = this.store.projection.requireRun(workflowRunId);
        if (isTerminalRunState(latestRun.state) || this.controller.isTerminating(latestRun.id)) {
          return;
        }
        const currentState = this.loadState(latestRun);
        const current = currentState.activations.get(activation.activationId);
        if (!current || current.completed) continue;
        const node = workflowNode(currentState.definition, current.nodeId);
        try {
          const result = await this.processNode(
            latestRun,
            currentState,
            node,
            current.activationId,
          );
          progressed = progressed || result;
        } catch (error) {
          if (!this.isActive(workflowRunId)) return;
          await this.controller.fail(workflowRunId, {
            code: "workflow_runtime_failed",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
          return;
        }
      }
      if (!progressed) return;
    }
  }

  private async processNode(
    run: RunRecord,
    state: WorkflowGraphState,
    node: WorkflowNode,
    activationId: string,
  ): Promise<boolean> {
    switch (node.kind) {
      case "invoke":
        return this.processInvoke(run, state, node, activationId);
      case "local": {
        await this.controller.transition(run.id, "running");
        if (!this.isActive(run.id)) return false;
        const task = await this.tasks.addLocal({
          ownerRunId: run.id,
          title: node.title ?? node.id,
          description: `Deterministic workflow operation ${node.operation}`,
        });
        if (!this.isActive(run.id)) return false;
        await this.tasks.setLocalState(task.id, "wip");
        if (!this.isActive(run.id)) return false;
        const operationController = new AbortController();
        const controllers = this.operationControllers.get(run.id) ?? new Set<AbortController>();
        controllers.add(operationController);
        this.operationControllers.set(run.id, controllers);
        const input = this.functions.mapping(node.input)(state.context);
        const operation = this.operations.run(node.operation, input, {
          cwd: this.cwd,
          signal: operationController.signal,
        });
        const active = this.activeOperations.get(run.id) ?? new Set<Promise<unknown>>();
        active.add(operation);
        this.activeOperations.set(run.id, active);
        try {
          const result = await operation;
          if (!this.isActive(run.id)) return false;
          await this.tasks.setLocalState(task.id, "done");
          if (!this.isActive(run.id)) return false;
          await this.completeAndAdvance(run.id, state, node, activationId, result);
        } catch (error) {
          if (!this.isActive(run.id) || operationController.signal.aborted) return false;
          await this.tasks.setLocalState(task.id, "failed");
          await this.controller.fail(run.id, {
            code: "local_step_failed",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
        } finally {
          controllers.delete(operationController);
          active.delete(operation);
          if (controllers.size === 0) this.operationControllers.delete(run.id);
          if (active.size === 0) this.activeOperations.delete(run.id);
        }
        return true;
      }
      case "decision": {
        await this.controller.transition(run.id, "running");
        const decision = this.functions.decision(node.decide)(state.context);
        await this.completeAndAdvance(run.id, state, node, activationId, decision);
        return true;
      }
      case "join":
        return this.processJoin(run, state, node, activationId);
      case "return": {
        if (this.controller.activeAttachedChildren(run.id).length > 0) {
          await this.controller.transition(run.id, "waiting");
          return false;
        }
        const failedChild = this.store.projection
          .childrenOf(run.id)
          .find(
            (child) =>
              child.ownership === "attached" &&
              child.outcome !== undefined &&
              child.outcome.status !== "success",
          );
        if (failedChild?.outcome) {
          await this.controller.fail(run.id, childFailure(failedChild, failedChild.outcome));
          return true;
        }
        await this.controller.transition(run.id, "completing");
        if (!this.isActive(run.id)) return false;
        if (this.controller.activeAttachedChildren(run.id).length > 0) {
          await this.controller.transition(run.id, "running");
          await this.controller.transition(run.id, "waiting");
          return false;
        }
        const output = this.functions.mapping(node.output)(state.context);
        await this.completeNode(run.id, node, activationId, output);
        await this.controller.complete(run.id, output);
        return true;
      }
      case "fail": {
        const mapped = this.functions.mapping(node.reason)(state.context);
        const message = typeof mapped === "string" ? mapped : JSON.stringify(mapped);
        await this.completeNode(run.id, node, activationId, mapped);
        await this.controller.fail(run.id, {
          code: "workflow_exhausted",
          message,
          retryable: false,
        });
        return true;
      }
    }
  }

  private async processInvoke(
    run: RunRecord,
    state: WorkflowGraphState,
    node: InvokeNode,
    activationId: string,
  ): Promise<boolean> {
    const child = this.store.projection
      .childrenOf(run.id)
      .find(
        (candidate) =>
          candidate.compiled.invocation.causation?.activationId === activationId &&
          candidate.compiled.invocation.causation?.nodeId === node.id,
      );
    if (!child) {
      if (
        this.controller.activeAttachedChildren(run.id).length >=
        state.definition.limits.maxParallelism
      ) {
        await this.controller.transition(run.id, "waiting");
        return false;
      }
      const mappedInput = this.functions.mapping(node.input)(state.context);
      const handle = await this.invoker.start({
        parentId: run.id,
        definition: node.definition,
        input: mappedInput,
        wait: node.wait,
        causation: {
          workflowRunId: run.id,
          nodeId: node.id,
          activationId,
        },
        trustedWorkflowInvocation: true,
      });
      if (node.wait === "background") {
        await this.completeAndAdvance(run.id, this.loadState(run), node, activationId, {
          runId: handle.id,
          status: "running",
        });
        return true;
      }
      await this.controller.transition(run.id, "waiting");
      return true;
    }

    if (!isTerminalRunState(child.state) || !child.outcome) {
      await this.controller.transition(run.id, "waiting");
      return false;
    }
    if (child.outcome.status !== "success") {
      await this.controller.fail(run.id, childFailure(child, child.outcome));
      return true;
    }
    await this.controller.transition(run.id, "running");
    await this.completeAndAdvance(run.id, state, node, activationId, child.outcome);
    return true;
  }

  private async processJoin(
    run: RunRecord,
    state: WorkflowGraphState,
    node: JoinNode,
    activationId: string,
  ): Promise<boolean> {
    const incoming = state.definition.graph.edges.filter((edge) => edge.to === node.id);
    const arrived = incoming.filter(
      (edge) => (state.context.transitionCounts.get(`${edge.from}->${edge.to}`) ?? 0) > 0,
    );
    const statuses = arrived.map((edge) => this.sourceStatus(run, state, edge.from));
    const successes = statuses.filter((status) => status === "success").length;
    const failures = statuses.filter((status) => status === "failure").length;
    const settled = statuses.filter((status) => status !== "pending").length;
    const quorum = node.quorum ?? Math.max(1, Math.ceil(incoming.length / 2));

    if (node.policy === "all-success" && failures > 0) {
      await this.controller.fail(run.id, {
        code: "workflow_exhausted",
        message: `Join ${node.id} observed a failed branch`,
        retryable: false,
      });
      return true;
    }

    const satisfied =
      node.policy === "first-success"
        ? successes > 0
        : node.policy === "quorum"
          ? successes >= quorum
          : arrived.length === incoming.length && settled === incoming.length;
    if (!satisfied) {
      await this.controller.transition(run.id, "waiting");
      return false;
    }

    await this.controller.transition(run.id, "running");
    const result = Object.fromEntries(
      incoming.map((edge) => [
        edge.from,
        state.context.childOutcomes.get(edge.from) ?? state.context.results.get(edge.from) ?? [],
      ]),
    );
    await this.completeAndAdvance(run.id, state, node, activationId, result);
    return true;
  }

  private sourceStatus(
    run: RunRecord,
    state: WorkflowGraphState,
    sourceNodeId: string,
  ): "pending" | "success" | "failure" {
    const source = workflowNode(state.definition, sourceNodeId);
    if (source.kind !== "invoke")
      return state.context.results.has(sourceNodeId) ? "success" : "pending";
    const children = this.store.projection
      .childrenOf(run.id)
      .filter((child) => child.compiled.invocation.causation?.nodeId === sourceNodeId);
    if (children.some((child) => !isTerminalRunState(child.state))) return "pending";
    if (children.length === 0) return "pending";
    return children.every((child) => child.outcome?.status === "success") ? "success" : "failure";
  }

  private async completeAndAdvance(
    runId: RunId,
    _state: WorkflowGraphState,
    node: WorkflowNode,
    activationId: string,
    result: unknown,
  ): Promise<void> {
    await this.completeNode(runId, node, activationId, result);
    const nextState = this.loadState(this.store.projection.requireRun(runId));
    const edges = this.selectEdges(nextState, node, result);
    if (edges.length === 0) {
      await this.controller.fail(runId, {
        code: "workflow_exhausted",
        message: `No legal transition from workflow node ${node.id}`,
        retryable: false,
      });
      return;
    }

    const pending: PendingDomainEvent[] = [];
    for (const edge of edges) {
      const key = `${edge.from}->${edge.to}`;
      const traversal = (nextState.context.transitionCounts.get(key) ?? 0) + 1;
      pending.push({
        runId,
        type: "workflow.transition.taken",
        data: { activationId, from: edge.from, to: edge.to, traversal },
      });
      const target = workflowNode(nextState.definition, edge.to);
      const joinAlreadyActive =
        target.kind === "join" && nextState.active.some((active) => active.nodeId === target.id);
      if (!joinAlreadyActive) pending.push(this.entered(runId, target.id));
    }
    await this.commit(runId, pending);
  }

  private selectEdges(
    state: WorkflowGraphState,
    node: WorkflowNode,
    result: unknown,
  ): readonly WorkflowEdge[] {
    return state.definition.graph.edges.filter((edge) => {
      if (edge.from !== node.id) return false;
      const count = state.context.transitionCounts.get(`${edge.from}->${edge.to}`) ?? 0;
      if (edge.maxTraversals !== undefined && count >= edge.maxTraversals) return false;
      return edge.when ? this.functions.condition(edge.when)(state.context, result) : true;
    });
  }

  private async completeNode(
    runId: RunId,
    node: WorkflowNode,
    activationId: string,
    result: unknown,
  ): Promise<void> {
    await this.commit(runId, [
      {
        runId,
        type: "workflow.node.completed",
        data: { activationId, nodeId: node.id, result },
      },
    ]);
  }

  private entered(runId: RunId, nodeId: string): PendingDomainEvent {
    return {
      runId,
      type: "workflow.node.entered",
      data: { activationId: this.ids.next("activation"), nodeId },
    };
  }

  private loadState(run: RunRecord): WorkflowGraphState {
    return buildWorkflowGraphState({
      run,
      definition: this.catalog.require(run.definitionId) as WorkflowDefinition<unknown, unknown>,
      events: this.store.projection.eventsFor(run.id),
      children: this.store.projection.childrenOf(run.id),
    });
  }

  private commit(
    runId: RunId,
    events: readonly PendingDomainEvent[],
  ): Promise<readonly DomainEvent[]> {
    return this.store.commit(this.store.projection.rootOf(runId), events);
  }

  private isActive(runId: RunId): boolean {
    const run = this.store.projection.runs.get(runId);
    return Boolean(run && !isTerminalRunState(run.state) && !this.controller.isTerminating(runId));
  }

  private async stopRunResources(runId: RunId): Promise<void> {
    clearTimeout(this.timers.get(runId));
    this.timers.delete(runId);
    const controllers = this.operationControllers.get(runId) ?? [];
    for (const controller of controllers) {
      controller.abort(new Error(`Workflow ${runId} was stopped`));
    }
    await Promise.allSettled([...(this.activeOperations.get(runId) ?? [])]);
    this.operationControllers.delete(runId);
    this.activeOperations.delete(runId);
  }

  private armTimeout(runId: RunId, definition: WorkflowDefinition<unknown, unknown>): void {
    if (definition.limits.timeoutMs <= 0 || this.timers.has(runId)) return;
    const run = this.store.projection.requireRun(runId);
    const requestedAt = Date.parse(run.requestedAt);
    const now = Date.parse(this.clock.now());
    const elapsed =
      Number.isFinite(requestedAt) && Number.isFinite(now) ? Math.max(0, now - requestedAt) : 0;
    const remaining = Math.max(0, definition.limits.timeoutMs - elapsed);
    const timer = setTimeout(() => {
      void this.controller
        .fail(runId, {
          code: "timeout",
          message: `Workflow timed out after ${definition.limits.timeoutMs}ms`,
          retryable: false,
        })
        .catch(() => undefined);
    }, remaining);
    timer.unref?.();
    this.timers.set(runId, timer);
  }
}

function requireWorkflow(definition: AnyDefinition): WorkflowDefinition<unknown, unknown> {
  if (definition.kind !== "workflow")
    throw new Error(`${definition.id} is not a workflow definition`);
  return definition;
}

function childFailure(child: RunRecord, outcome: Outcome<unknown>): Failure {
  if (outcome.status === "failure") {
    return { ...outcome.failure, causeRunId: child.id };
  }
  if (outcome.status === "cancelled") {
    return {
      code: "cancelled",
      message: `Child ${child.id} was cancelled: ${outcome.reason}`,
      retryable: false,
      causeRunId: child.id,
    };
  }
  return {
    code: "workflow_exhausted",
    message: `Child ${child.id} did not provide a usable outcome`,
    retryable: false,
    causeRunId: child.id,
  };
}

function isTerminalEvent(type: string): boolean {
  return ["run.completed", "run.failed", "run.cancelled", "run.orphaned"].includes(type);
}
