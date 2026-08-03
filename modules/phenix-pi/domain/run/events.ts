import type {
  AttentionDeliveredData,
  AttentionDeliveryDeferredData,
  AttentionDeliveryFailedData,
  AttentionReceivedData,
  AttentionRoutedData,
  AttentionRoutingFailedData,
} from "../attention/model.ts";
import type { ResolvedModel } from "../definition/model.ts";
import type { Objective } from "../objective/model.ts";
import type {
  Failure,
  LocalTaskId,
  ObjectiveId,
  Outcome,
  RunId,
  TaskId,
  ValidationIssue,
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

type EmptyEventData = Readonly<Record<string, never>>;
type SuccessOutcome = Extract<Outcome<unknown>, { readonly status: "success" }>;
type FailureOutcome = Extract<Outcome<unknown>, { readonly status: "failure" }>;
type CancelledOutcome = Extract<Outcome<unknown>, { readonly status: "cancelled" }>;

export type RunCreatedData = { readonly record: Omit<RunRecord, "revision" | "state"> };
export type RunStateChangedData = { readonly from: RunState; readonly to: RunState };
export type RunProfileSelectedData = {
  readonly previous: SessionProfile;
  readonly profile: SessionProfile;
  readonly source: "user" | "model-select" | "policy";
};
export type RunModelResolvedData = { readonly resolved: ResolvedModel };
export type RunModelObservedData = { readonly model: NonNullable<RunRecord["observedModel"]> };
export type RunPiBoundData = { readonly pi: NonNullable<RunRecord["pi"]> };
export type RunCycleData = { readonly number: number };
export type RunToolStartedData = { readonly toolName: string };
export type RunInputAmendedData = { readonly text: string };
export type RunOutputSubmittedData = { readonly output: unknown };
export type RunOutputRejectedData = { readonly issues: readonly ValidationIssue[] };
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
export type RunCompletedData = { readonly outcome: SuccessOutcome };
export type RunFailedData = { readonly outcome: FailureOutcome };
export type RunCancelledData = { readonly outcome: CancelledOutcome };
export type RunOrphanedData = { readonly outcome: FailureOutcome };
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
 * Closed internal event protocol. New Phenix capabilities extend this map in-repository;
 * consumers then receive compile errors until the new variant is handled deliberately.
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
  readonly "run.turn.ended": EmptyEventData;
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
  readonly [Type in TType]: DomainEventMetadata & {
    readonly type: Type;
    readonly data: DomainEventDataMap[Type];
  };
}[TType];

export type UnsequencedDomainEvent<TType extends DomainEventType = DomainEventType> = {
  readonly [Type in TType]: UnsequencedDomainEventMetadata & {
    readonly type: Type;
    readonly data: DomainEventDataMap[Type];
  };
}[TType];

export type PendingDomainEvent<TType extends DomainEventType = DomainEventType> = {
  readonly [Type in TType]: PendingDomainEventMetadata & {
    readonly type: Type;
    readonly data: DomainEventDataMap[Type];
  };
}[TType];

export const DOMAIN_EVENT_TYPES = Object.freeze({
  "run.created": true,
  "run.state.changed": true,
  "run.profile.selected": true,
  "run.model.resolved": true,
  "run.model.observed": true,
  "run.pi.bound": true,
  "run.cycle.started": true,
  "run.cycle.settled": true,
  "run.turn.ended": true,
  "run.tool.started": true,
  "run.activity.changed": true,
  "run.fact.recorded": true,
  "run.input.amended": true,
  "run.output.submitted": true,
  "run.output.rejected": true,
  "run.budget.suspended": true,
  "run.budget.resumed": true,
  "run.completed": true,
  "run.failed": true,
  "run.cancelled": true,
  "run.orphaned": true,
  "run.reparented": true,
  "attention.received": true,
  "attention.routed": true,
  "attention.routing.failed": true,
  "attention.delivery.deferred": true,
  "attention.delivered": true,
  "attention.delivery.failed": true,
  "workflow.node.entered": true,
  "workflow.node.completed": true,
  "workflow.transition.taken": true,
  "workflow.checkpoint.saved": true,
  "task.local.created": true,
  "task.local.state.changed": true,
  "task.progress.appended": true,
  "objective.created": true,
  "objective.state.changed": true,
  "objective.focus.changed": true,
  "objective.progress.appended": true,
} as const satisfies Readonly<Record<DomainEventType, true>>);

export function isDomainEventType(value: string): value is DomainEventType {
  return value in DOMAIN_EVENT_TYPES;
}

export type RunActivityChangedEvent = DomainEvent<"run.activity.changed">;
export type RunFactRecordedEvent = DomainEvent<"run.fact.recorded">;
export type RunDomainEvent = DomainEvent;

export function modelResolvedData(resolved: ResolvedModel): RunModelResolvedData {
  return { resolved };
}
