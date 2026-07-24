import type { DefinitionId, Outcome, RunId } from "../domain/shared.ts";
import type { RunRetryOptions, RunSnapshot, StartRun } from "../domain/run/model.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { ExecutionFacade, RunHandle } from "./interfaces.ts";

/**
 * Model-facing execution view.
 *
 * Runtime process managers receive the authoritative execution façade directly.
 * Model tools receive this view, which removes runtime-internal definitions from
 * start, retry, inspection, messaging, cancellation, and reparenting authority.
 */
export class ModelExecutionFacade implements ExecutionFacade {
  private readonly execution: ExecutionFacade;
  private readonly store: ExecutionStore;
  private readonly hiddenDefinitions: ReadonlySet<DefinitionId>;

  constructor(input: {
    readonly execution: ExecutionFacade;
    readonly store: ExecutionStore;
    readonly hiddenDefinitions?: readonly DefinitionId[];
  }) {
    this.execution = input.execution;
    this.store = input.store;
    this.hiddenDefinitions = new Set(input.hiddenDefinitions ?? []);
  }

  start<I, O>(request: StartRun<I, O>): Promise<RunHandle<O>> {
    this.assertDefinitionVisible(request.definition.id);
    return this.execution.start(request);
  }

  async inspect(runId: RunId): Promise<RunSnapshot> {
    this.assertRunVisible(runId);
    return this.execution.inspect(runId);
  }

  await<O>(runId: RunId, signal?: AbortSignal): Promise<Outcome<O>> {
    this.assertRunVisible(runId);
    return this.execution.await<O>(runId, signal);
  }

  send(runId: RunId, message: string, signal?: AbortSignal): Promise<void> {
    this.assertRunVisible(runId);
    return this.execution.send(runId, message, signal);
  }

  notify(runId: RunId, message: string): Promise<void> {
    this.assertRunVisible(runId);
    return this.execution.notify(runId, message);
  }

  cancel(runId: RunId, reason: string): Promise<void> {
    this.assertRunVisible(runId);
    return this.execution.cancel(runId, reason);
  }

  retry<O>(
    callerId: RunId,
    targetId: RunId,
    options?: RunRetryOptions,
  ): Promise<RunHandle<O>> {
    this.assertRunVisible(callerId);
    this.assertRunVisible(targetId);
    return this.execution.retry<O>(callerId, targetId, options);
  }

  reparent(runId: RunId, newParentId: RunId): Promise<void> {
    this.assertRunVisible(runId);
    this.assertRunVisible(newParentId);
    return this.execution.reparent(runId, newParentId);
  }

  private assertRunVisible(runId: RunId): void {
    const run = this.store.projection.requireRun(runId);
    this.assertDefinitionVisible(run.definitionId);
  }

  private assertDefinitionVisible(definitionId: DefinitionId): void {
    if (this.hiddenDefinitions.has(definitionId)) {
      throw new Error(`Definition ${definitionId} is internal to the Phenix runtime`);
    }
  }
}
