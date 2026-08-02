import type { AttentionResult, AttentionSubmitRequest } from "../domain/attention/model.ts";
import type { Definition, DefinitionRef } from "../domain/definition/definition.ts";
import type { BudgetMode } from "../domain/definition/effort.ts";
import type { Difficulty, PhenixModelSetId } from "../domain/definition/model.ts";
import type { Objective } from "../domain/objective/model.ts";
import type { ObjectiveNode, ObjectiveTree } from "../domain/objective/projection.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import type {
  RunRetryOptions,
  RunSnapshot,
  SessionAgentPreset,
  SessionProfile,
  StartRun,
} from "../domain/run/model.ts";
import type { RunActivity, RunFact } from "../domain/run/observability.ts";
import type {
  DefinitionId,
  LocalTaskId,
  ObjectiveId,
  ObjectiveState,
  Outcome,
  RunId,
  TaskId,
} from "../domain/shared.ts";
import type { LocalTask } from "../domain/task/local-task.ts";
import type { TaskNode, TaskTree } from "../domain/task/projection.ts";
import type { WorkflowDiagnostic } from "../domain/workflow/validator.ts";

export interface RunHandle<O> {
  readonly id: RunId;
  snapshot(): Promise<RunSnapshot>;
  result(signal?: AbortSignal): Promise<Outcome<O>>;
  send(message: string, signal?: AbortSignal): Promise<void>;
  cancel(reason: string): Promise<void>;
  subscribe(listener: (event: DomainEvent) => void): () => void;
}

export interface ExecutionFacade {
  start<I, O>(request: StartRun<I, O>): Promise<RunHandle<O>>;
  inspect(runId: RunId): Promise<RunSnapshot>;
  await<O>(runId: RunId, signal?: AbortSignal): Promise<Outcome<O>>;
  send(runId: RunId, message: string, signal?: AbortSignal): Promise<void>;
  notify(runId: RunId, message: string): Promise<void>;
  cancel(runId: RunId, reason: string): Promise<void>;
  retry<O>(callerId: RunId, targetId: RunId, options?: RunRetryOptions): Promise<RunHandle<O>>;
  reparent(runId: RunId, newParentId: RunId): Promise<void>;
}

export interface AttentionFacade {
  hasActiveTargets(rootRunId: RunId): boolean;
  submit(request: AttentionSubmitRequest): Promise<AttentionResult>;
}

export interface SessionProfileUpdate {
  readonly agent?: SessionAgentPreset;
  readonly modelSet?: PhenixModelSetId;
  readonly difficulty?: Difficulty;
  readonly budget?: BudgetMode;
  readonly source: "user" | "model-select" | "policy";
}

export interface SessionProfileFacade {
  current(rootRunId: RunId): Promise<SessionProfile>;
  select(rootRunId: RunId, update: SessionProfileUpdate): Promise<SessionProfile>;
}

export interface ObjectiveFacade {
  tree(rootRunId: RunId): Promise<ObjectiveTree>;
  current(runId: RunId): Promise<ObjectiveNode | undefined>;
  add(input: {
    readonly actorRunId: RunId;
    readonly parentObjectiveId?: ObjectiveId;
    readonly title: string;
    readonly description?: string;
    readonly focus?: boolean;
  }): Promise<Objective>;
  setState(actorRunId: RunId, objectiveId: ObjectiveId, state: ObjectiveState): Promise<Objective>;
  focus(runId: RunId, objectiveId: ObjectiveId): Promise<Objective>;
  appendProgress(actorRunId: RunId, objectiveId: ObjectiveId, message: string): Promise<void>;
}

/** Internal execution telemetry for deterministic local workflow steps. */
export interface TaskFacade {
  tree(rootRunId: RunId): Promise<TaskTree>;
  tasksFor(runId: RunId): Promise<readonly TaskNode[]>;
  addLocal(input: {
    readonly ownerRunId: RunId;
    readonly title: string;
    readonly description?: string;
  }): Promise<LocalTask>;
  setLocalState(
    taskId: LocalTaskId,
    state: "not_started" | "wip" | "done" | "failed",
  ): Promise<LocalTask>;
  appendProgress(taskId: TaskId, message: string): Promise<void>;
}

export interface DefinitionSummary {
  readonly id: DefinitionId;
  readonly kind: "agent" | "workflow" | "session";
  readonly title: string;
  readonly description: string;
  readonly inputSchema: string;
  readonly outputSchema: string;
}

export interface CatalogFacade {
  get<I, O>(ref: DefinitionRef<I, O>): Definition<I, O>;
  listAvailable(parentId: RunId): Promise<readonly DefinitionSummary[]>;
  validateAll(): readonly WorkflowDiagnostic[];
}

export interface RunTreeNode {
  readonly run: RunSnapshot;
  readonly activity?: RunActivity;
  readonly children: readonly RunTreeNode[];
}

export interface RunTree {
  readonly root: RunTreeNode;
}

export interface QueryFacade {
  runTree(rootRunId: RunId): Promise<RunTree>;
  facts(rootRunId: RunId, limit?: number): Promise<readonly RunFact[]>;
  activeRuns(rootRunId: RunId): Promise<readonly RunSnapshot[]>;
  events(rootRunId: RunId, afterSequence?: number): AsyncIterable<DomainEvent>;
}
