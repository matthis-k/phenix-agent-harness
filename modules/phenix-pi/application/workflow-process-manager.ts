import type {
  AnyDefinition,
  InvokeNode,
  LocalNode,
  ReturnNode,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTransitionOutcome,
} from "../domain/definition/definition.ts";
import { type Difficulty, isDifficulty } from "../domain/definition/model.ts";
import type { Schema } from "../domain/definition/schema.ts";
import type { DomainEvent, PendingDomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord, RunRetryLimitOverrides, RunRetryOptions } from "../domain/run/model.ts";
import { type Failure, failed, type Outcome, type RunId, success } from "../domain/shared.ts";
import {
  buildWorkflowGraphState,
  type WorkflowGraphState,
  workflowNode,
} from "../domain/workflow/graph-state.ts";
import { planWorkflowStep, type WorkflowStepPlan } from "../domain/workflow/planner.ts";
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
  private readonly resolveSchema: (id: string) => Schema<unknown>;
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
    readonly resolveSchema: (id: string) => Schema<unknown>;
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
    this.resolveSchema = input.resolveSchema;
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
      const children = this.store.projection.childrenOf(run.id);
      const plan = planWorkflowStep({
        state,
        children,
        activeAttachedChildren: this.controller.activeAttachedChildren(run.id).length,
        selectEdges: (currentState, node, result, outcome) =>
          this.selectEdges(currentState, node, result, outcome),
      });

      if (plan.kind === "fail-workflow") {
        await this.controller.fail(run.id, plan.failure);
        return;
      }
      if (plan.kind === "wait") {
        await this.controller.transition(run.id, "waiting");
        return;
      }

      try {
        await this.executePlan(run, state, plan);
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
  }

  private async executePlan(
    run: RunRecord,
    state: WorkflowGraphState,
    plan: Exclude<WorkflowStepPlan, { readonly kind: "fail-workflow" | "wait" }>,
  ): Promise<void> {
    switch (plan.kind) {
      case "run-local":
        await this.runLocal(run, state, plan.node, plan.activationId);
        return;
      case "evaluate-decision": {
        await this.controller.transition(run.id, "running");
        const decision = this.functions.decision(plan.node.decide)(state.context);
        await this.completeAndAdvance(run.id, plan.node, plan.activationId, decision, "success");
        return;
      }
      case "start-child":
        await this.startChild(run, state, plan.node, plan.activationId);
        return;
      case "retry-child":
        await this.retryChild(run, plan.node, plan.activationId, plan.child);
        return;
      case "complete-invoke":
        await this.completeInvoke(run, plan.node, plan.activationId, plan.child);
        return;
      case "complete-join":
        await this.controller.transition(run.id, "running");
        await this.completeAndAdvance(
          run.id,
          plan.node,
          plan.activationId,
          plan.result,
          "success",
        );
        return;
      case "complete-return":
        await this.completeReturn(run, plan.node, plan.activationId);
        return;
      case "fail-node": {
        const mapped = this.functions.mapping(plan.node.reason)(state.context);
        const message = typeof mapped === "string" ? mapped : JSON.stringify(mapped);
        await this.completeNode(run.id, plan.node, plan.activationId, mapped);
        await this.controller.fail(run.id, {
          code: "workflow_exhausted",
          message,
          retryable: false,
        });
        return;
      }
    }
  }

  private async runLocal(
    run: RunRecord,
    state: WorkflowGraphState,
    node: LocalNode,
    activationId: string,
  ): Promise<void> {
    await this.controller.transition(run.id, "running");
    if (!this.isActive(run.id)) return;
    const task = await this.tasks.addLocal({
      ownerRunId: run.id,
      title: node.title ?? node.id,
      description: `Deterministic workflow operation ${node.operation}`,
    });
    if (!this.isActive(run.id)) return;
    await this.tasks.setLocalState(task.id, "wip");
    if (!this.isActive(run.id)) return;

    const operationController = new AbortController();
    const controllers = this.operationControllers.get(run.id) ?? new Set<AbortController>();
    controllers.add(operationController);
    this.operationControllers.set(run.id, controllers);
    const input = this.functions.mapping(node.input)(state.context);
    const operation = this.operations.run(node.operation, input, {
      cwd: this.cwd,
      signal: operationController.signal,
      executionId: workflowEffectId(run.id, activationId, node.id),
    });
    const active = this.activeOperations.get(run.id) ?? new Set<Promise<unknown>>();
    active.add(operation);
    this.activeOperations.set(run.id, active);
    try {
      const result = await operation;
      if (!this.isActive(run.id)) return;
      await this.tasks.setLocalState(task.id, "done");
      if (!this.isActive(run.id)) return;
      await this.completeAndAdvance(run.id, node, activationId, result, "success");
    } catch (error) {
      if (!this.isActive(run.id) || operationController.signal.aborted) return;
      await this.tasks.setLocalState(task.id, "failed");
      const failure: Failure = {
        code: "local_step_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
      const outcome = failed(failure);
      if (this.selectEdges(state, node, outcome, "failure").length === 0) {
        await this.controller.fail(run.id, failure);
      } else {
        await this.completeAndAdvance(run.id, node, activationId, outcome, "failure");
      }
    } finally {
      controllers.delete(operationController);
      active.delete(operation);
      if (controllers.size === 0) this.operationControllers.delete(run.id);
      if (active.size === 0) this.activeOperations.delete(run.id);
    }
  }

  private async startChild(
    run: RunRecord,
    state: WorkflowGraphState,
    node: InvokeNode,
    activationId: string,
  ): Promise<void> {
    const mappedInput = this.prepareInvokeInput(node, state);
    const difficulty = this.resolveDifficulty(run, state, node);
    const handle = await this.invoker.start({
      parentId: run.id,
      definition: node.definition,
      input: mappedInput,
      wait: node.wait,
      ...(difficulty ? { difficulty } : {}),
      causation: {
        workflowRunId: run.id,
        nodeId: node.id,
        activationId,
      },
      trustedWorkflowInvocation: true,
    });
    if (node.wait === "background") {
      await this.completeAndAdvance(
        run.id,
        node,
        activationId,
        { runId: handle.id, status: "running" },
        "success",
      );
      return;
    }
    await this.controller.transition(run.id, "waiting");
  }

  private async retryChild(
    run: RunRecord,
    node: InvokeNode,
    activationId: string,
    child: RunRecord,
  ): Promise<void> {
    const retryOverrides = suggestedRetryOverrides(child);
    await this.invoker.start({
      parentId: run.id,
      definition: node.definition,
      input: child.input,
      wait: node.wait,
      ...(child.compiled.difficulty ? { difficulty: child.compiled.difficulty } : {}),
      causation: {
        workflowRunId: run.id,
        nodeId: node.id,
        activationId,
      },
      trustedWorkflowInvocation: true,
      retryOf: child.id,
      ...(retryOverrides ? { retryOverrides } : {}),
    });
    await this.controller.transition(run.id, "waiting");
  }

  private async completeInvoke(
    run: RunRecord,
    node: InvokeNode,
    activationId: string,
    child: RunRecord,
  ): Promise<void> {
    if (!child.outcome) throw new Error(`Child ${child.id} has no terminal outcome`);
    const outcomeStatus = child.outcome.status;
    let outcome = child.outcome;
    if (outcome.status === "success" && this.isStockNode(node)) {
      try {
        outcome = this.validateStockOutcome(node, outcome.value);
      } catch (error) {
        await this.controller.fail(run.id, {
          code: "output_invalid",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          causeRunId: child.id,
        });
        return;
      }
    }

    await this.controller.transition(run.id, "running");
    await this.completeAndAdvance(run.id, node, activationId, outcome, outcomeStatus);
  }

  private async completeReturn(
    run: RunRecord,
    node: ReturnNode,
    activationId: string,
  ): Promise<void> {
    await this.controller.transition(run.id, "completing");
    if (!this.isActive(run.id)) return;
    if (this.controller.activeAttachedChildren(run.id).length > 0) {
      await this.controller.transition(run.id, "running");
      await this.controller.transition(run.id, "waiting");
      return;
    }
    const state = this.loadState(this.store.projection.requireRun(run.id));
    const output = this.functions.mapping(node.output)(state.context);
    await this.completeNode(run.id, node, activationId, output);
    await this.controller.complete(run.id, output);
  }

  private prepareInvokeInput(node: InvokeNode, state: WorkflowGraphState): unknown {
    const mapped = this.functions.mapping(node.input)(state.context);
    if (!this.isStockNode(node)) return mapped;
    if (!node.outputSchema) throw new Error(`Stock session node ${node.id} has no output schema`);
    if (!isRecord(mapped)) {
      throw new Error(`Stock session node ${node.id} input mapping must return an object`);
    }
    const schema = this.resolveSchema(node.outputSchema);
    return {
      ...mapped,
      outputSchema: schema.id,
      outputContract: schema.jsonSchema,
    };
  }

  private validateStockOutcome(node: InvokeNode, value: unknown): Outcome<unknown> {
    if (!node.outputSchema) throw new Error(`Stock session node ${node.id} has no output schema`);
    if (!isRecord(value)) throw new Error(`Stock session ${node.id} returned no typed handoff`);
    const outputSchema = value.outputSchema;
    if (outputSchema !== node.outputSchema) {
      throw new Error(
        `Stock session ${node.id} returned schema ${String(outputSchema)} instead of ${node.outputSchema}`,
      );
    }
    const schema = this.resolveSchema(node.outputSchema);
    const validation = schema.validate(value.value);
    if (!validation.ok) {
      throw new Error(
        `Stock session ${node.id} output is invalid: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }
    return success(validation.value);
  }

  private isStockNode(node: InvokeNode): boolean {
    const definition = this.catalog.require(node.definition.id);
    return definition.kind === "agent" && definition.sessionMode === "stock";
  }

  private resolveDifficulty(
    run: RunRecord,
    state: WorkflowGraphState,
    node: InvokeNode,
  ): Difficulty | undefined {
    if (!node.difficulty) return run.compiled.difficulty;
    if (node.difficulty.kind === "fixed") return node.difficulty.value;
    return difficultyFromResult(
      state.context.latest.get(node.difficulty.nodeId),
      node.difficulty.nodeId,
    );
  }

  private async completeAndAdvance(
    runId: RunId,
    node: WorkflowNode,
    activationId: string,
    result: unknown,
    outcome: WorkflowTransitionOutcome,
  ): Promise<void> {
    await this.completeNode(runId, node, activationId, result);
    const nextState = this.loadState(this.store.projection.requireRun(runId));
    const edges = this.selectEdges(nextState, node, result, outcome);
    if (edges.length === 0) {
      await this.controller.fail(runId, {
        code: "workflow_exhausted",
        message: `No legal ${outcome} transition from workflow node ${node.id}`,
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
        data: { activationId, from: edge.from, to: edge.to, traversal, outcome },
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
    outcome: WorkflowTransitionOutcome,
  ): readonly WorkflowEdge[] {
    return state.definition.graph.edges.filter((edge) => {
      if (edge.from !== node.id || !matchesOutcome(edge, outcome)) return false;
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

function suggestedRetryOverrides(child: RunRecord): Omit<RunRetryOptions, "wait"> | undefined {
  if (child.outcome?.status !== "failure") return undefined;
  const details = child.outcome.failure.details;
  if (!isRecord(details) || !isRecord(details.suggestedLimits)) return undefined;
  const limits = sanitizeRetryLimits(details.suggestedLimits);
  return limits ? { limits } : undefined;
}

function sanitizeRetryLimits(
  value: Readonly<Record<string, unknown>>,
): RunRetryLimitOverrides | undefined {
  const timeoutMs = boundedInteger(value.timeoutMs, 1, 3_600_000);
  const maxTurns = boundedInteger(value.maxTurns, 1, 200);
  const maxToolCalls = boundedInteger(value.maxToolCalls, 1, 1_000);
  const maxRepairAttempts = boundedInteger(value.maxRepairAttempts, 0, 10);
  if (
    timeoutMs === undefined &&
    maxTurns === undefined &&
    maxToolCalls === undefined &&
    maxRepairAttempts === undefined
  ) {
    return undefined;
  }
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    ...(maxRepairAttempts !== undefined ? { maxRepairAttempts } : {}),
  };
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function workflowEffectId(runId: RunId, activationId: string, nodeId: string): string {
  return `${runId}:${activationId}:${nodeId}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesOutcome(edge: WorkflowEdge, outcome: WorkflowTransitionOutcome): boolean {
  const accepted = edge.on ?? "success";
  return accepted === "any" || accepted === outcome;
}

function difficultyFromResult(value: unknown, nodeId: string): Difficulty {
  const outcome = value as Outcome<unknown> | undefined;
  if (outcome?.status !== "success") {
    throw new Error(`Difficulty source ${nodeId} has no successful result`);
  }
  const assessment = outcome.value;
  if (typeof assessment !== "object" || assessment === null) {
    throw new Error(`Difficulty source ${nodeId} did not return an assessment object`);
  }
  const difficulty = (assessment as { readonly difficulty?: unknown }).difficulty;
  if (typeof difficulty !== "string" || !isDifficulty(difficulty)) {
    throw new Error(`Difficulty source ${nodeId} returned an invalid difficulty`);
  }
  return difficulty;
}

function requireWorkflow(definition: AnyDefinition): WorkflowDefinition<unknown, unknown> {
  if (definition.kind !== "workflow")
    throw new Error(`${definition.id} is not a workflow definition`);
  return definition;
}

function isTerminalEvent(type: string): boolean {
  return ["run.completed", "run.failed", "run.cancelled", "run.orphaned"].includes(type);
}
