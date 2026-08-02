import type { ResolvedModel } from "../definition/model.ts";
import type { Objective } from "../objective/model.ts";
import type { Failure, ObjectiveId, Outcome, RunId } from "../shared.ts";
import type { WorkflowCheckpointSavedData } from "../workflow/checkpoint.ts";
import type { RunRecord, RunState, SessionProfile } from "./model.ts";
import type { RunActivityChangedData, RunFactRecordedData } from "./observability.ts";

export interface DomainEvent<TType extends string = string, TData = unknown> {
  readonly eventId: string;
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly sequence: number;
  readonly revision: number;
  readonly timestamp: string;
  readonly type: TType;
  readonly data: TData;
}

export interface UnsequencedDomainEvent<TType extends string = string, TData = unknown> {
  readonly eventId: string;
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly revision: number;
  readonly timestamp: string;
  readonly type: TType;
  readonly data: TData;
}

export interface PendingDomainEvent<TType extends string = string, TData = unknown> {
  readonly eventId?: string;
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly type: TType;
  readonly data: TData;
}

export type RunCreatedData = { readonly record: Omit<RunRecord, "revision" | "state"> };
export type RunStateChangedData = { readonly from: RunState; readonly to: RunState };
export type RunTerminalData = { readonly outcome: Outcome<unknown> };
export type RunFailedData = { readonly failure: Failure };
export type RunProfileSelectedData = {
  readonly previous: SessionProfile;
  readonly profile: SessionProfile;
  readonly source: "user" | "model-select" | "policy";
};
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

export type DomainEventType =
  | "run.created"
  | "run.started"
  | "run.state.changed"
  | "run.profile.selected"
  | "run.model.resolved"
  | "run.model.observed"
  | "run.pi.bound"
  | "run.cycle.started"
  | "run.cycle.settled"
  | "run.turn.ended"
  | "run.tool.started"
  | "run.activity.changed"
  | "run.fact.recorded"
  | "run.input.amended"
  | "run.output.submitted"
  | "run.output.rejected"
  | "run.budget.suspended"
  | "run.budget.resumed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.orphaned"
  | "run.reparented"
  | "attention.received"
  | "attention.routed"
  | "attention.routing.failed"
  | "attention.delivery.deferred"
  | "attention.delivered"
  | "attention.delivery.failed"
  | "workflow.node.entered"
  | "workflow.node.completed"
  | "workflow.transition.taken"
  | "workflow.checkpoint.saved"
  | "objective.created"
  | "objective.state.changed"
  | "objective.focus.changed"
  | "objective.progress.appended";

export type RunActivityChangedEvent = DomainEvent<"run.activity.changed", RunActivityChangedData>;
export type RunFactRecordedEvent = DomainEvent<"run.fact.recorded", RunFactRecordedData>;
export type RunDomainEvent = DomainEvent<DomainEventType, unknown>;

export function modelResolvedData(resolved: ResolvedModel): { readonly resolved: ResolvedModel } {
  return { resolved };
}
