declare const runIdBrand: unique symbol;
declare const definitionIdBrand: unique symbol;
declare const objectiveIdBrand: unique symbol;
declare const localTaskIdBrand: unique symbol;

export type RunId<TValue extends string = string> = TValue & {
  readonly [runIdBrand]: "RunId";
};
export type DefinitionId<TValue extends string = string> = TValue & {
  readonly [definitionIdBrand]: "DefinitionId";
};
export type ObjectiveId<TValue extends string = string> = TValue & {
  readonly [objectiveIdBrand]: "ObjectiveId";
};
export type LocalTaskId<TValue extends string = string> = TValue & {
  readonly [localTaskIdBrand]: "LocalTaskId";
};
export type TaskId = `run:${RunId}` | LocalTaskId;

const MAX_ID_LENGTH = 160;
const GENERAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEFINITION_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export function runId<const TValue extends string>(value: TValue): RunId<TValue> {
  return validateId("run ID", value, GENERAL_ID) as RunId<TValue>;
}

export function definitionId<const TValue extends string>(value: TValue): DefinitionId<TValue> {
  return validateId("definition ID", value, DEFINITION_ID) as DefinitionId<TValue>;
}

export function objectiveId<const TValue extends string>(value: TValue): ObjectiveId<TValue> {
  return validateId("objective ID", value, GENERAL_ID) as ObjectiveId<TValue>;
}

export function localTaskId<const TValue extends string>(value: TValue): LocalTaskId<TValue> {
  return validateId("local task ID", value, GENERAL_ID) as LocalTaskId<TValue>;
}

function validateId(name: string, value: string, pattern: RegExp): string {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
  if (value.length > MAX_ID_LENGTH) {
    throw new Error(`${name} must not exceed ${MAX_ID_LENGTH} characters`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${name} contains unsupported characters: ${value}`);
  }
  return value;
}

export type FailureCode =
  | "definition_not_found"
  | "input_invalid"
  | "model_unavailable"
  | "backend_start_failed"
  | "agent_reported_failure"
  | "provider_failed"
  | "timeout"
  | "turn_budget_exceeded"
  | "tool_budget_exceeded"
  | "output_missing"
  | "output_invalid"
  | "workflow_invalid"
  | "workflow_definition_drift"
  | "workflow_definition_invalid"
  | "workflow_runtime_failed"
  | "workflow_rejected"
  | "workflow_exhausted"
  | "local_step_failed"
  | "tool_unavailable"
  | "cancelled"
  | "orphaned";

export type FailureCategory =
  | "blocked"
  | "deadlock"
  | "insufficient_permissions"
  | "resource_limit"
  | "invalid_task"
  | "external_failure"
  | "other";

export interface FailureLimitSuggestion {
  readonly timeoutMs?: number;
  readonly maxTurns?: number | null;
  readonly maxToolCalls?: number | null;
  readonly maxRepairAttempts?: number;
}

export interface FailureReport {
  readonly source: "agent" | "automatic";
  readonly category: FailureCategory;
  readonly summary: string;
  readonly retryable: boolean;
  readonly requestedTools?: readonly string[];
  readonly suggestedLimits?: FailureLimitSuggestion;
}

export function defaultAgentFailureRetryable(
  category: FailureCategory,
  suggestedLimits?: FailureLimitSuggestion,
): boolean {
  if (category === "external_failure") return true;
  if (category !== "resource_limit" || suggestedLimits === undefined) return false;
  return Object.values(suggestedLimits).some((value) => value !== undefined);
}

export interface Failure {
  readonly code: FailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly causeRunId?: RunId;
  readonly details?: unknown;
}

export interface SuccessOutcome<O> {
  readonly status: "success";
  readonly value: O;
}

export interface FailureOutcome {
  readonly status: "failure";
  readonly failure: Failure;
}

export interface CancelledOutcome {
  readonly status: "cancelled";
  readonly reason: string;
}

export type Outcome<O> = SuccessOutcome<O> | FailureOutcome | CancelledOutcome;

export function success<O>(value: O): SuccessOutcome<O> {
  return { status: "success", value };
}

export function failed(failure: Failure): FailureOutcome {
  return { status: "failure", failure };
}

export function cancelled(reason: string): CancelledOutcome {
  return { status: "cancelled", reason };
}

export type TaskState = "not_started" | "wip" | "done" | "failed";
export type ObjectiveState = "not_started" | "wip" | "done" | "blocked";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
