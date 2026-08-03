import type {
  AttentionDeliveredData,
  AttentionDeliveryDeferredData,
  AttentionDeliveryFailedData,
  AttentionReceivedData,
  AttentionRoutedData,
  AttentionRoutingFailedData,
} from "../attention/model.ts";
import type { WorkflowTransitionOutcome } from "../definition/definition.ts";
import type { ConcreteModelRef, ResolvedModel } from "../definition/model.ts";
import type { Objective } from "../objective/model.ts";
import type {
  CancelledOutcome,
  FailedOutcome,
  Failure,
  LocalTaskId,
  ObjectiveId,
  RunId,
  SuccessfulOutcome,
  TaskId,
} from "../shared.ts";
import type { LocalTask } from "../task/local-task.ts";
import type { WorkflowCheckpointSavedData } from "../workflow/checkpoint.ts";
import type {
  RunLimits,
  RunRecord,
  RunRetryLimitOverrides,
  RunState,
  SessionProfile,
} from "./model.ts";
import type { RunActivityChangedData, RunFactRecordedData } from "./observability.ts";

export type NoEventData = Readonly<Record<string, never>>;

export type RunCreatedData = { readonly record: Omit<RunRecord, "revision" | "state"> };
export type RunStateChangedData = { readonly from: RunState; readonly to: RunState };
export type RunProfileSelectedData = {
  readonly previous: SessionProfile;
  readonly profile: SessionProfile;
  readonly source: "user" | "model-select" | "policy";
};
export type RunModelResolvedData = { readonly resolved: ResolvedModel };
export type RunModelObservedData = { readonly model: ConcreteModelRef };
export type RunPiBoundData = { readonly pi: NonNullable<RunRecord["pi"]> };
export type RunCycleData = { readonly number: number };
export type RunToolStartedData = { readonly toolName: string };
export type RunInputAmendedData = { readonly text: string };
export type RunOutputSubmittedData = { readonly output: unknown };
export type RunOutputRejectedData = { readonly issues: unknown };
export type RunBudgetSuspendedData = {
  readonly failure: Failure;
  readonly currentLimits: RunLimits;
  readonly suggestedLimits: RunRetryLimitOverrides;
  readonly timeoutRemainingMs?: number;
  readonly turnCount: number;
  readonly toolCallCount: number;
};
export type RunBudgetResumedData = {
  readonly limits: RunLimits;
  readonly timeoutRemainingMs?: number;
};
export type RunCompletedData = { readonly outcome: SuccessfulOutcome<unknown> };
export type RunFailedData = { readonly outcome: FailedOutcome };
export type RunCancelledData = { readonly outcome: CancelledOutcome };
export type RunOrphanedData = { readonly outcome: FailedOutcome };
export type RunReparentedData = {
  readonly previousParentId: RunId;
  readonly newParentId: RunId;
  readonly ownership: "attached" | "detached";
};

export interface WorkflowNodeEnteredData {
  readonly activationId: string;
  readonly nodeId: string;
}

export interface WorkflowNodeCompletedData {
  readonly activationId: string;
  readonly nodeId: string;
  readonly result: unknown;
}

export interface WorkflowTransitionTakenData {
  readonly activationId: string;
  readonly from: string;
  readonly to: string;
  readonly outcome: WorkflowTransitionOutcome;
  readonly traversal: number;
}

export type WorkflowCheckpointData = WorkflowCheckpointSavedData;

export interface LocalTaskCreatedData {
  readonly task: LocalTask;
}

export interface LocalTaskStateChangedData {
  readonly taskId: LocalTaskId;
  readonly state: LocalTask["state"];
  readonly updatedAt: string;
}

export interface TaskProgressAppendedData {
  readonly taskId: TaskId;
  readonly message: string;
}

export interface ObjectiveCreatedData {
  readonly objective: Objective;
}

export interface ObjectiveStateChangedData {
  readonly objectiveId: ObjectiveId;
  readonly state: Objective["state"];
  readonly updatedAt: string;
}

export interface ObjectiveFocusChangedData {
  readonly objectiveId: ObjectiveId;
}

export interface ObjectiveProgressAppendedData {
  readonly objectiveId: ObjectiveId;
  readonly message: string;
}

/**
 * Closed core protocol for the in-repository Phenix runtime.
 * Adding an event requires declaring its payload here and updating exhaustive consumers.
 */
export interface DomainEventDataMap {
  readonly "run.created": RunCreatedData;
  readonly "run.state.changed": RunStateChangedData;
  readonly "run.profile.selected": RunProfileSelectedData;
  readonly "run.model.resolved": RunModelResolvedData;
  readonly "run.model.observed": RunModelObservedData;
  readonly "run.pi.bound": RunPiBoundData;
  readonly "run.cycle.started": RunCycleData;
  readonly "run.cycle.settled": RunCycleData;
  readonly "run.turn.ended": NoEventData;
  readonly "run.tool.started": RunToolStartedData;
  readonly "run.activity.changed": RunActivityChangedData;
  readonly "run.fact.recorded": RunFactRecordedData;
  readonly "run.input.amended": RunInputAmendedData;
  readonly "run.output.submitted": RunOutputSubmittedData;
  readonly "run.output.rejected": RunOutputRejectedData;
  readonly "run.budget.suspended": RunBudgetSuspendedData;
  readonly "run.budget.resumed": RunBudgetResumedData;
  readonly "run.completed": RunCompletedData;
  readonly "run.failed": RunFailedData;
  readonly "run.cancelled": RunCancelledData;
  readonly "run.orphaned": RunOrphanedData;
  readonly "run.reparented": RunReparentedData;
  readonly "attention.received": AttentionReceivedData;
  readonly "attention.routed": AttentionRoutedData;
  readonly "attention.routing.failed": AttentionRoutingFailedData;
  readonly "attention.delivery.deferred": AttentionDeliveryDeferredData;
  readonly "attention.delivered": AttentionDeliveredData;
  readonly "attention.delivery.failed": AttentionDeliveryFailedData;
  readonly "workflow.node.entered": WorkflowNodeEnteredData;
  readonly "workflow.node.completed": WorkflowNodeCompletedData;
  readonly "workflow.transition.taken": WorkflowTransitionTakenData;
  readonly "workflow.checkpoint.saved": WorkflowCheckpointData;
  readonly "task.local.created": LocalTaskCreatedData;
  readonly "task.local.state.changed": LocalTaskStateChangedData;
  readonly "task.progress.appended": TaskProgressAppendedData;
  readonly "objective.created": ObjectiveCreatedData;
  readonly "objective.state.changed": ObjectiveStateChangedData;
  readonly "objective.focus.changed": ObjectiveFocusChangedData;
  readonly "objective.progress.appended": ObjectiveProgressAppendedData;
}

export type DomainEventType = keyof DomainEventDataMap;
export type DomainEventData<TType extends DomainEventType> = DomainEventDataMap[TType];

interface DomainEventMetadata {
  readonly eventId: string;
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly sequence: number;
  readonly revision: number;
  readonly timestamp: string;
}

interface UnsequencedDomainEventMetadata {
  readonly eventId: string;
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly revision: number;
  readonly timestamp: string;
}

interface PendingDomainEventMetadata {
  readonly eventId?: string;
  readonly runId: RunId;
  readonly parentRunId?: RunId;
}

export type DomainEvent<TType extends DomainEventType = DomainEventType> = {
  [TCurrent in TType]: DomainEventMetadata & {
    readonly type: TCurrent;
    readonly data: DomainEventDataMap[TCurrent];
  };
}[TType];

export type UnsequencedDomainEvent<TType extends DomainEventType = DomainEventType> = {
  [TCurrent in TType]: UnsequencedDomainEventMetadata & {
    readonly type: TCurrent;
    readonly data: DomainEventDataMap[TCurrent];
  };
}[TType];

export type PendingDomainEvent<TType extends DomainEventType = DomainEventType> = {
  [TCurrent in TType]: PendingDomainEventMetadata & {
    readonly type: TCurrent;
    readonly data: DomainEventDataMap[TCurrent];
  };
}[TType];

export type RunActivityChangedEvent = DomainEvent<"run.activity.changed">;
export type RunFactRecordedEvent = DomainEvent<"run.fact.recorded">;
export type RunDomainEvent = DomainEvent;

export function modelResolvedData(resolved: ResolvedModel): RunModelResolvedData {
  return { resolved };
}
