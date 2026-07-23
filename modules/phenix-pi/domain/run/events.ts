import type { ResolvedModel } from "../definition/model.ts";
import type { Failure, LocalTaskId, Outcome, RunId } from "../shared.ts";
import type { RunRecord, RunState } from "./model.ts";

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

export interface LocalTaskCreatedData {
  readonly task: {
    readonly id: LocalTaskId;
    readonly ownerRunId: RunId;
    readonly title: string;
    readonly description?: string;
    readonly state: "not_started" | "wip" | "done" | "failed";
    readonly createdAt: string;
    readonly updatedAt: string;
  };
}

export type DomainEventType =
  | "run.created"
  | "run.started"
  | "run.state.changed"
  | "run.model.resolved"
  | "run.model.observed"
  | "run.pi.bound"
  | "run.cycle.started"
  | "run.cycle.settled"
  | "run.turn.ended"
  | "run.tool.started"
  | "run.input.amended"
  | "run.output.submitted"
  | "run.output.rejected"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.orphaned"
  | "run.reparented"
  | "workflow.node.entered"
  | "workflow.node.completed"
  | "workflow.transition.taken"
  | "task.local.created"
  | "task.local.state.changed"
  | "task.progress.appended";

export type RunDomainEvent = DomainEvent<DomainEventType, unknown>;

export function modelResolvedData(resolved: ResolvedModel): { readonly resolved: ResolvedModel } {
  return { resolved };
}
