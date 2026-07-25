import type { WorkflowDefinition } from "../domain/definition/definition.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import type { RunId } from "../domain/shared.ts";
import {
  createWorkflowCheckpoint,
  latestCompatibleWorkflowCheckpoint,
} from "../domain/workflow/checkpoint.ts";
import {
  buildWorkflowGraphState,
  workflowCheckpointSnapshot,
} from "../domain/workflow/graph-state.ts";
import type { DefinitionCatalog } from "./catalog.ts";
import type { ExecutionStore } from "./execution-store.ts";
import { KeyedSerialExecutor } from "./keyed-serial-executor.ts";

const CHECKPOINT_TRIGGER_EVENTS = new Set([
  "workflow.node.entered",
  "workflow.node.completed",
  "workflow.transition.taken",
]);

export class WorkflowCheckpointProcessManager {
  private readonly store: ExecutionStore;
  private readonly catalog: DefinitionCatalog;
  private readonly serial = new KeyedSerialExecutor<RunId>();
  private readonly pending = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(input: {
    readonly store: ExecutionStore;
    readonly catalog: DefinitionCatalog;
  }) {
    this.store = input.store;
    this.catalog = input.catalog;
    this.unsubscribe = this.store.events.subscribe((event) => this.onDomainEvent(event));
  }

  async checkpoint(runId: RunId): Promise<void> {
    await this.serial.run(runId, () => this.save(runId));
  }

  async shutdown(): Promise<void> {
    this.unsubscribe();
    await Promise.allSettled([...this.pending]);
  }

  private onDomainEvent(event: DomainEvent): void {
    if (!CHECKPOINT_TRIGGER_EVENTS.has(event.type)) return;
    const operation = this.checkpoint(event.runId);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }

  private async save(runId: RunId): Promise<void> {
    const run = this.store.projection.runs.get(runId);
    if (!run || run.kind !== "workflow") return;
    const definition = this.catalog.require(run.definitionId);
    if (definition.kind !== "workflow") return;

    const events = this.store.projection.eventsFor(runId);
    const throughSequence = latestWorkflowStateSequence(events);
    if (throughSequence === undefined) return;
    const restored = latestCompatibleWorkflowCheckpoint({ definition, events });
    if (restored && restored.throughSequence >= throughSequence) return;

    const state = buildWorkflowGraphState({
      run,
      definition: definition as WorkflowDefinition<unknown, unknown>,
      events,
      children: this.store.projection.childrenOf(runId),
    });
    const data = createWorkflowCheckpoint({
      definition,
      throughSequence,
      snapshot: workflowCheckpointSnapshot(state),
    });
    await this.store.commit(this.store.projection.rootOf(runId), [
      {
        runId,
        type: "workflow.checkpoint.saved",
        data,
      },
    ]);
  }
}

function latestWorkflowStateSequence(events: readonly DomainEvent[]): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (!CHECKPOINT_TRIGGER_EVENTS.has(event.type)) continue;
    latest = event.sequence;
  }
  return latest;
}
