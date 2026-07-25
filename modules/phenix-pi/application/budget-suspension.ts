import type { DomainEvent, PendingDomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunLimits, RunRetryLimitOverrides } from "../domain/run/model.ts";
import type { Failure, Outcome, RunId } from "../domain/shared.ts";
import type { ExecutionStore } from "./execution-store.ts";

export const BUDGET_SUSPENDED_EVENT = "run.budget.suspended";
export const BUDGET_RESUMED_EVENT = "run.budget.resumed";
const RESUME_CONTROL_PREFIX = "phenix:budget-resume:";

export interface BudgetSuspension {
  readonly runId: RunId;
  readonly failure: Failure;
  readonly currentLimits: RunLimits;
  readonly suggestedLimits: RunRetryLimitOverrides;
  readonly timeoutRemainingMs: number;
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly timestamp: string;
  readonly sequence: number;
}

export interface BudgetResumeControl {
  readonly limits?: RunRetryLimitOverrides;
  readonly message?: string;
}

export type AwaitedRun<O> =
  | { readonly status: "completed"; readonly outcome: Outcome<O> }
  | { readonly status: "suspended"; readonly suspension: BudgetSuspension };

interface BudgetSuspendedData {
  readonly failure: Failure;
  readonly currentLimits: RunLimits;
  readonly suggestedLimits: RunRetryLimitOverrides;
  readonly timeoutRemainingMs: number;
  readonly turnCount: number;
  readonly toolCallCount: number;
}

interface BudgetResumedData {
  readonly limits: RunLimits;
  readonly timeoutRemainingMs: number;
}

export function budgetSuspendedEvent(runId: RunId, data: BudgetSuspendedData): PendingDomainEvent {
  return { runId, type: BUDGET_SUSPENDED_EVENT, data };
}

export function budgetResumedEvent(runId: RunId, data: BudgetResumedData): PendingDomainEvent {
  return { runId, type: BUDGET_RESUMED_EVENT, data };
}

export function pendingBudgetSuspension(
  store: ExecutionStore,
  runId: RunId,
): BudgetSuspension | undefined {
  const events = store.projection.eventsFor(runId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.type === BUDGET_RESUMED_EVENT) return undefined;
    if (event.type !== BUDGET_SUSPENDED_EVENT) continue;
    const data = event.data as BudgetSuspendedData;
    return {
      runId,
      failure: data.failure,
      currentLimits: data.currentLimits,
      suggestedLimits: data.suggestedLimits,
      timeoutRemainingMs: data.timeoutRemainingMs,
      turnCount: data.turnCount,
      toolCallCount: data.toolCallCount,
      timestamp: event.timestamp,
      sequence: event.sequence,
    };
  }
  return undefined;
}

export function latestBudgetState(
  store: ExecutionStore,
  runId: RunId,
): { readonly limits: RunLimits; readonly timeoutRemainingMs?: number } {
  const run = store.projection.requireRun(runId);
  const pending = pendingBudgetSuspension(store, runId);
  if (pending) {
    return {
      limits: pending.currentLimits,
      timeoutRemainingMs: pending.timeoutRemainingMs,
    };
  }
  const events = store.projection.eventsFor(runId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== BUDGET_RESUMED_EVENT) continue;
    const data = event.data as BudgetResumedData;
    return { limits: data.limits, timeoutRemainingMs: data.timeoutRemainingMs };
  }
  return { limits: run.compiled.limits };
}

export function pendingBudgetSuspensionInScope(
  store: ExecutionStore,
  scopeRunId: RunId,
): BudgetSuspension | undefined {
  let latest: BudgetSuspension | undefined;
  for (const run of store.projection.runs.values()) {
    if (!isDescendantOrSelf(store, scopeRunId, run.id)) continue;
    const pending = pendingBudgetSuspension(store, run.id);
    if (pending && (!latest || pending.sequence > latest.sequence)) latest = pending;
  }
  return latest;
}

export function encodeBudgetResumeControl(control: BudgetResumeControl): string {
  return `${RESUME_CONTROL_PREFIX}${JSON.stringify(control)}`;
}

export function parseBudgetResumeControl(message: string): BudgetResumeControl | undefined {
  if (!message.startsWith(RESUME_CONTROL_PREFIX)) return undefined;
  const payload = message.slice(RESUME_CONTROL_PREFIX.length);
  const parsed = JSON.parse(payload) as unknown;
  if (!isRecord(parsed)) throw new Error("Invalid budget resume control payload");
  const limits = parseLimitOverrides(parsed.limits);
  const userMessage =
    typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : undefined;
  return {
    ...(limits ? { limits } : {}),
    ...(userMessage ? { message: userMessage } : {}),
  };
}

export function resolveResumeLimits(
  suspension: BudgetSuspension,
  requested?: RunRetryLimitOverrides,
): RunLimits {
  const selected = requested ?? suspension.suggestedLimits;
  const current = suspension.currentLimits;
  const timeoutMs = resolveTimeoutLimit(current.timeoutMs, selected.timeoutMs);
  const next: RunLimits = {
    timeoutMs,
    ...resolveOptionalLimit("maxTurns", current.maxTurns, selected.maxTurns),
    ...resolveOptionalLimit("maxToolCalls", current.maxToolCalls, selected.maxToolCalls),
    ...resolveRepairLimit(current.maxRepairAttempts, selected.maxRepairAttempts),
    ...(current.maxNodeRuns === undefined ? {} : { maxNodeRuns: current.maxNodeRuns }),
    ...(current.maxParallelism === undefined ? {} : { maxParallelism: current.maxParallelism }),
  };

  const increased =
    timeoutIncreased(current.timeoutMs, next.timeoutMs) ||
    increasedOptional(current.maxTurns, next.maxTurns) ||
    increasedOptional(current.maxToolCalls, next.maxToolCalls) ||
    (next.maxRepairAttempts ?? 0) > (current.maxRepairAttempts ?? 0);
  if (!increased) {
    throw new Error("Resume requires at least one increased or removed budget limit");
  }
  return next;
}

export function resumedTimeoutRemaining(
  suspension: BudgetSuspension,
  nextLimits: RunLimits,
): number {
  if (suspension.currentLimits.timeoutMs <= 0) return suspension.timeoutRemainingMs;
  const added = Math.max(0, nextLimits.timeoutMs - suspension.currentLimits.timeoutMs);
  return Math.max(0, suspension.timeoutRemainingMs + added);
}

export async function awaitOutcomeOrBudget<O>(input: {
  readonly store: ExecutionStore;
  readonly runId: RunId;
  readonly signal?: AbortSignal;
}): Promise<AwaitedRun<O>> {
  const immediate = settledState<O>(input.store, input.runId);
  if (immediate) return immediate;
  if (input.signal?.aborted) throw abortError(input.signal);

  return new Promise<AwaitedRun<O>>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (value: AwaitedRun<O>): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      resolve(value);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(abortError(input.signal));
    };
    unsubscribe = input.store.events.subscribe((event) => {
      if (!affectsScope(input.store, input.runId, event)) return;
      const current = settledState<O>(input.store, input.runId);
      if (current) finish(current);
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const current = settledState<O>(input.store, input.runId);
    if (current) finish(current);
  });
}

function settledState<O>(store: ExecutionStore, runId: RunId): AwaitedRun<O> | undefined {
  const run = store.projection.requireRun(runId);
  if (isTerminalRunState(run.state) && run.outcome) {
    return { status: "completed", outcome: run.outcome as Outcome<O> };
  }
  const suspension = pendingBudgetSuspensionInScope(store, runId);
  return suspension ? { status: "suspended", suspension } : undefined;
}

function affectsScope(store: ExecutionStore, scopeRunId: RunId, event: DomainEvent): boolean {
  if (event.runId === scopeRunId) return true;
  if (event.type !== BUDGET_SUSPENDED_EVENT && event.type !== BUDGET_RESUMED_EVENT) return false;
  return isDescendantOrSelf(store, scopeRunId, event.runId);
}

function isDescendantOrSelf(store: ExecutionStore, ancestorId: RunId, candidateId: RunId): boolean {
  let current = store.projection.runs.get(candidateId);
  while (current) {
    if (current.id === ancestorId) return true;
    current = current.parentId ? store.projection.runs.get(current.parentId) : undefined;
  }
  return false;
}

function parseLimitOverrides(value: unknown): RunRetryLimitOverrides | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Budget resume limits must be an object");
  const timeoutMs = boundedInteger(value.timeoutMs, 1, 3_600_000, "timeoutMs");
  const maxTurns = nullableBoundedInteger(value.maxTurns, 1, 200, "maxTurns");
  const maxToolCalls = nullableBoundedInteger(value.maxToolCalls, 1, 1_000, "maxToolCalls");
  const maxRepairAttempts = boundedInteger(value.maxRepairAttempts, 0, 10, "maxRepairAttempts");
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(maxRepairAttempts === undefined ? {} : { maxRepairAttempts }),
  };
}

function resolveTimeoutLimit(current: number, requested: number | undefined): number {
  if (requested === undefined) return current;
  if (current <= 0) {
    throw new Error("timeoutMs is already unbounded and may not be replaced by a finite limit");
  }
  if (requested < current) throw new Error(`timeoutMs may not decrease from ${current}`);
  return requested;
}

function resolveOptionalLimit(
  name: string,
  current: number | undefined,
  requested: number | null | undefined,
): Readonly<Record<string, number>> {
  if (requested === undefined) return current === undefined ? {} : { [name]: current };
  if (requested === null) return {};
  if (current === undefined) {
    throw new Error(`${name} is already unbounded and may not be replaced by a finite limit`);
  }
  if (requested < current) throw new Error(`${name} may not decrease from ${current}`);
  return { [name]: requested };
}

function resolveRepairLimit(
  current: number | undefined,
  requested: number | undefined,
): Readonly<Record<string, number>> {
  if (requested === undefined) return current === undefined ? {} : { maxRepairAttempts: current };
  if (requested < (current ?? 0)) {
    throw new Error(`maxRepairAttempts may not decrease from ${current ?? 0}`);
  }
  return { maxRepairAttempts: requested };
}

function timeoutIncreased(current: number, next: number): boolean {
  return current > 0 && next > current;
}

function increasedOptional(current: number | undefined, next: number | undefined): boolean {
  if (current === undefined) return false;
  return next === undefined || next > current;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function nullableBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number | null | undefined {
  if (value === null || value === undefined) return value;
  return boundedInteger(value, minimum, maximum, name);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}
