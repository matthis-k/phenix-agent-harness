export type RunId = string & { readonly __brand: "RunId" };
export type DefinitionId = string & { readonly __brand: "DefinitionId" };
export type LocalTaskId = string & { readonly __brand: "LocalTaskId" };
export type TaskId = `run:${RunId}` | LocalTaskId;

const MAX_ID_LENGTH = 160;
const GENERAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEFINITION_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export function runId(value: string): RunId {
  return validateId("run ID", value, GENERAL_ID) as RunId;
}

export function definitionId(value: string): DefinitionId {
  return validateId("definition ID", value, DEFINITION_ID) as DefinitionId;
}

export function localTaskId(value: string): LocalTaskId {
  return validateId("local task ID", value, GENERAL_ID) as LocalTaskId;
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
  | "workflow_runtime_failed"
  | "workflow_exhausted"
  | "local_step_failed"
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
