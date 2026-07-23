export type RunId = string & { readonly __brand: "RunId" };
export type DefinitionId = string & { readonly __brand: "DefinitionId" };
export type LocalTaskId = string & { readonly __brand: "LocalTaskId" };
export type TaskId = `run:${RunId}` | LocalTaskId;

export function runId(value: string): RunId {
  return value as RunId;
}

export function definitionId(value: string): DefinitionId {
  return value as DefinitionId;
}

export function localTaskId(value: string): LocalTaskId {
  return value as LocalTaskId;
}

export type FailureCode =
  | "definition_not_found"
  | "input_invalid"
  | "model_unavailable"
  | "backend_start_failed"
  | "provider_failed"
  | "timeout"
  | "turn_budget_exceeded"
  | "tool_budget_exceeded"
  | "output_missing"
  | "output_invalid"
  | "workflow_invalid"
  | "workflow_runtime_failed"
  | "workflow_exhausted"
  | "local_step_failed"
  | "cancelled"
  | "orphaned";

export interface Failure {
  readonly code: FailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly causeRunId?: RunId;
  readonly details?: unknown;
}

export type Outcome<O> =
  | { readonly status: "success"; readonly value: O }
  | { readonly status: "failure"; readonly failure: Failure }
  | { readonly status: "cancelled"; readonly reason: string };

export function success<O>(value: O): Outcome<O> {
  return { status: "success", value };
}

export function failed<O = never>(failure: Failure): Outcome<O> {
  return { status: "failure", failure };
}

export function cancelled<O = never>(reason: string): Outcome<O> {
  return { status: "cancelled", reason };
}

export type TaskState = "not_started" | "wip" | "done" | "failed";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
