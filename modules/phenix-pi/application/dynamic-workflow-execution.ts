import type { WorkflowDefinition } from "../domain/definition/definition.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import {
  type CompiledRunSpec,
  DEFAULT_SESSION_PROFILE,
  type RunRecord,
} from "../domain/run/model.ts";
import { type DefinitionId, type RunId } from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type {
  RunController,
  RunImplementation,
  StartImplementationCommand,
} from "./execution-facade.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { CatalogFacade, ExecutionFacade, RunHandle } from "./interfaces.ts";
import {
  DynamicWorkflowDriftError,
  type DynamicWorkflowRuntimeRegistry,
} from "./dynamic-workflow-runtime.ts";

export interface DynamicWorkflowStartRequest<I> {
  readonly parentId: RunId;
  readonly scopeRunId: RunId;
  readonly proposal: unknown;
  readonly input: I;
  readonly wait: "await" | "background";
}

export class DynamicWorkflowExecutionService {
  private readonly registry: DynamicWorkflowRuntimeRegistry;
  private readonly catalog: CatalogFacade;
  private readonly store: ExecutionStore;
  private readonly controller: RunController;
  private readonly workflow: RunImplementation;
  private readonly execution: ExecutionFacade;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;

  constructor(input: {
    readonly registry: DynamicWorkflowRuntimeRegistry;
    readonly catalog: CatalogFacade;
    readonly store: ExecutionStore;
    readonly controller: RunController;
    readonly workflow: RunImplementation;
    readonly execution: ExecutionFacade;
    readonly ids: IdGenerator;
    readonly clock: Clock;
  }) {
    this.registry = input.registry;
    this.catalog = input.catalog;
    this.store = input.store;
    this.controller = input.controller;
    this.workflow = input.workflow;
    this.execution = input.execution;
    this.ids = input.ids;
    this.clock = input.clock;
  }

  async start<I, O>(request: DynamicWorkflowStartRequest<I>): Promise<RunHandle<O>> {
    const parent = this.requireActiveParent(request.parentId);
    this.assertSameRoot(parent.id, request.scopeRunId);
    const allowedDefinitionIds = await this.availableDefinitionIds(request.scopeRunId);
    const compiled = this.registry.compile(request.proposal, allowedDefinitionIds);
    const validation = compiled.definition.input.validate(request.input);
    if (!validation.ok) {
      throw new Error(
        `Input for ${compiled.definition.id} is invalid: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }

    const currentParent = this.requireActiveParent(request.parentId);
    this.assertSameRoot(currentParent.id, request.scopeRunId);
    const currentAllowed = await this.availableDefinitionIds(request.scopeRunId);
    this.assertDefinitionScope(compiled.definition, currentAllowed);
    this.assertDelegationDepth(currentParent);

    const rootRunId = this.store.projection.rootOf(currentParent.id);
    const root = this.store.projection.requireRun(rootRunId);
    const difficulty =
      currentParent.compiled.difficulty ??
      root.profile?.difficulty ??
      DEFAULT_SESSION_PROFILE.difficulty;
    const snapshot = this.registry.install(compiled);
    const capabilities = workflowCapabilities(compiled.definition, currentParent);
    const runId = this.ids.next("run") as RunId;
    const runSpec: CompiledRunSpec = {
      definitionId: compiled.definition.id,
      input: validation.value,
      outputSchemaId: compiled.definition.output.id,
      tools: [],
      difficulty,
      limits: compiled.definition.limits,
      capabilities,
      invocation: { wait: request.wait },
      dynamicWorkflow: snapshot,
    };
    const record: Omit<RunRecord, "revision" | "state"> = {
      id: runId,
      parentId: currentParent.id,
      kind: "workflow",
      definitionId: compiled.definition.id,
      input: validation.value,
      outputSchemaId: compiled.definition.output.id,
      requestedAt: this.clock.now(),
      ownership: "attached",
      compiled: runSpec,
    };

    await this.store.commit(rootRunId, [
      {
        runId,
        parentRunId: currentParent.id,
        type: "run.created",
        data: { record },
      },
    ]);

    const command: StartImplementationCommand = {
      rootRunId,
      runId,
      parentId: currentParent.id,
      definition: compiled.definition,
      input: validation.value,
    };
    try {
      await this.workflow.start(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.controller.fail(runId, {
        code: "backend_start_failed",
        message,
        retryable: true,
        details: {
          source: "automatic",
          category: "external_failure",
          summary: message,
          retryable: true,
        },
      });
    }
    return this.handle<O>(runId);
  }

  async restoreRoot(rootRunId: RunId): Promise<void> {
    const runs = [...this.store.projection.runs.values()]
      .filter(
        (run) =>
          this.store.projection.rootOf(run.id) === rootRunId &&
          run.compiled.dynamicWorkflow !== undefined,
      )
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));

    for (const run of runs) {
      const snapshot = run.compiled.dynamicWorkflow;
      if (!snapshot) continue;
      try {
        const restored = this.registry.restore(snapshot);
        if (restored.definition.id !== run.definitionId) {
          throw new Error(
            `Persisted dynamic workflow ${run.definitionId} restored as ${restored.definition.id}`,
          );
        }
      } catch (error) {
        if (isTerminalRunState(run.state)) continue;
        const drift = error instanceof DynamicWorkflowDriftError;
        await this.controller.fail(run.id, {
          code: drift ? "workflow_definition_drift" : "workflow_definition_invalid",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          ...(drift
            ? {
                details: {
                  expected: error.expected,
                  actual: error.actual,
                },
              }
            : {}),
        });
      }
    }
  }

  private requireActiveParent(runId: RunId): RunRecord {
    const parent = this.store.projection.requireRun(runId);
    if (isTerminalRunState(parent.state) || parent.state === "completing") {
      throw new Error(`Cannot start a dynamic workflow from ${parent.state} parent ${runId}`);
    }
    return parent;
  }

  private assertSameRoot(parentId: RunId, scopeRunId: RunId): void {
    const parentRoot = this.store.projection.rootOf(parentId);
    const scopeRoot = this.store.projection.rootOf(scopeRunId);
    if (parentRoot !== scopeRoot) {
      throw new Error(`Composition scope ${scopeRunId} is outside parent ${parentId}'s root`);
    }
  }

  private async availableDefinitionIds(scopeRunId: RunId): Promise<readonly DefinitionId[]> {
    return (await this.catalog.listAvailable(scopeRunId)).map((definition) => definition.id);
  }

  private assertDefinitionScope(
    definition: WorkflowDefinition<unknown, unknown>,
    allowedDefinitionIds: readonly DefinitionId[],
  ): void {
    const allowed = new Set(allowedDefinitionIds);
    for (const node of definition.graph.nodes) {
      if (node.kind === "invoke" && !allowed.has(node.definition.id)) {
        throw new Error(
          `Dynamic workflow scope no longer permits ${node.definition.id} at node ${node.id}`,
        );
      }
    }
  }

  private assertDelegationDepth(parent: RunRecord): void {
    if (this.depth(parent.id) + 1 > parent.compiled.capabilities.maxDepth) {
      throw new Error(`Dynamic workflow exceeds delegation depth from ${parent.id}`);
    }
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

  private handle<O>(runId: RunId): RunHandle<O> {
    return {
      id: runId,
      snapshot: () => this.execution.inspect(runId),
      result: (signal) => this.execution.await<O>(runId, signal),
      send: (message, signal) => this.execution.send(runId, message, signal),
      cancel: (reason) => this.execution.cancel(runId, reason),
      subscribe: (listener) =>
        this.store.events.subscribe((event) => {
          if (event.runId === runId) listener(event);
        }),
    };
  }
}

function workflowCapabilities(
  definition: WorkflowDefinition<unknown, unknown>,
  parent: RunRecord,
): RunRecord["compiled"]["capabilities"] {
  return {
    invokableDefinitions: [
      ...new Set(
        definition.graph.nodes.flatMap((node) =>
          node.kind === "invoke" ? [node.definition.id] : [],
        ),
      ),
    ],
    maxDepth: parent.compiled.capabilities.maxDepth,
    mayDetach: false,
    maySend: false,
    mayCancelChildren: true,
  };
}
