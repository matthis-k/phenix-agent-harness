import type { DomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import {
  BUDGET_SUSPENDED_EVENT,
  type BudgetSuspension,
  pendingBudgetSuspension,
} from "./budget-suspension.ts";
import type { ExecutionStore } from "./execution-store.ts";
import { formatPresentationNotice, isPresentationFact } from "./presentation.ts";

export type RootNotifier = (message: string) => void | Promise<void>;

interface SupervisionExecution {
  notify(runId: RunId, message: string): Promise<void>;
}

/**
 * Reacts to canonical execution events with bounded supervisory notifications.
 *
 * This is deliberately a process manager rather than an anonymous composition
 * subscriber: it is the sole owner of descendant terminal, retry, budget,
 * presentation, and parent-attention notification policy.
 */
export class SupervisionProcessManager {
  private readonly execution: SupervisionExecution;
  private readonly store: ExecutionStore;
  private readonly notifyRoot: RootNotifier;
  private readonly unsubscribe: () => void;

  constructor(input: {
    readonly execution: SupervisionExecution;
    readonly store: ExecutionStore;
    readonly notifyRoot: RootNotifier;
  }) {
    this.execution = input.execution;
    this.store = input.store;
    this.notifyRoot = input.notifyRoot;
    this.unsubscribe = this.store.events.subscribe((event) => this.onDomainEvent(event));
  }

  shutdown(): void {
    this.unsubscribe();
  }

  private async onDomainEvent(event: DomainEvent): Promise<void> {
    const run = this.store.projection.runs.get(event.runId);
    if (!run) return;

    switch (event.type) {
      case "run.fact.recorded":
        if (isPresentationFact(event.data)) {
          await this.notifyRoot(formatPresentationNotice(run.id, event.data));
        }
        return;
      case BUDGET_SUSPENDED_EVENT:
        await this.onBudgetSuspended(run);
        return;
      case "run.created":
        await this.onRetryStarted(run);
        return;
      default:
        if (isTerminalEvent(event.type)) await this.onTerminal(run);
    }
  }

  private async onBudgetSuspended(run: RunRecord): Promise<void> {
    const suspension = pendingBudgetSuspension(this.store, run.id);
    if (!suspension) return;

    const summary = summarizeBudgetSuspension(suspension);
    await this.notifyRoot(summary);

    const parent = run.parentId ? this.store.projection.runs.get(run.parentId) : undefined;
    const parentCanResume = parent?.kind === "agent" && !isTerminalRunState(parent.state);
    if (parentCanResume) {
      await this.execution.notify(
        parent.id,
        `${summary} Decide whether to resume the same session with phenix_handle action=resume, supply different larger limits, cancel it, or leave it suspended. Do not use retry for this budget request.`,
      );
    }
  }

  private async onRetryStarted(run: RunRecord): Promise<void> {
    const retryOf = run.compiled.invocation.retryOf;
    if (!retryOf) return;

    const original = this.store.projection.runs.get(retryOf);
    const parent = run.parentId ? this.store.projection.runs.get(run.parentId) : undefined;
    await this.notifyRoot(
      parent?.kind === "workflow"
        ? summarizeWorkflowRetryStart(run, original, parent)
        : summarizeRetryStart(run, original),
    );
  }

  private async onTerminal(run: RunRecord): Promise<void> {
    if (!run.parentId) return;
    const parent = this.store.projection.runs.get(run.parentId);
    if (!parent || parent.kind === "workflow") return;

    const retryOf = run.compiled.invocation.retryOf;
    const failed = run.outcome?.status === "failure";
    const recoveryAttempted =
      run.kind === "workflow" &&
      this.store.projection
        .childrenOf(run.id)
        .some((child) => child.compiled.invocation.retryOf !== undefined);
    const summary =
      run.kind === "workflow" && failed
        ? summarizeWorkflowTerminal(run, recoveryAttempted)
        : summarizeTerminal(run.outcome, run.id, retryOf);
    const completedInBackground =
      run.compiled.invocation.wait === "background" && parent.kind === "root";
    const shouldNotifyRoot = failed || retryOf !== undefined || completedInBackground;

    if (shouldNotifyRoot) await this.notifyRoot(summary);
    if (parent.kind !== "agent" || isTerminalRunState(parent.state)) return;

    if (failed) {
      await this.execution.notify(
        parent.id,
        `${summary} Inspect the failure report, inform the user, and decide whether to retry with phenix_handle, choose a different route, ask for user input, or stop.`,
      );
    } else if (run.compiled.invocation.wait === "background") {
      await this.execution.notify(parent.id, summary);
    }
  }
}

function isTerminalEvent(type: string): boolean {
  return ["run.completed", "run.failed", "run.cancelled", "run.orphaned"].includes(type);
}

export function summarizeBudgetSuspension(suspension: BudgetSuspension): string {
  const current = JSON.stringify(suspension.currentLimits);
  const suggested = JSON.stringify(suspension.suggestedLimits);
  return `Run ${suspension.runId} is budget-suspended [${suspension.failure.code}]: ${suspension.failure.message}. The existing Pi session and accumulated context are retained. Current limits: ${current}. Suggested limits: ${suggested}. Counters: ${suspension.turnCount} turns, ${suspension.toolCallCount} tool calls. Resume this exact run with phenix_handle action=resume; retry would create a replacement session.`;
}

export function summarizeRetryStart(
  retry: Pick<RunRecord, "id" | "compiled">,
  original: Pick<RunRecord, "id" | "compiled"> | undefined,
): string {
  const originalTools = new Set(original?.compiled.tools ?? []);
  const addedTools = retry.compiled.tools.filter((tool) => !originalTools.has(tool));
  const changes = original
    ? changedLimits(retry.compiled.limits, original.compiled.limits)
    : retry.compiled.limits;
  const tools = addedTools.length > 0 ? ` Added tools: ${addedTools.join(", ")}.` : "";
  const limits = changes ? ` Changed limits: ${JSON.stringify(changes)}.` : "";
  return `Recovery run ${retry.id} started for failed run ${original?.id ?? "unknown"}.${tools}${limits} The original outcome remains immutable.`;
}

export function summarizeWorkflowRetryStart(
  retry: Pick<RunRecord, "compiled">,
  original: Pick<RunRecord, "outcome" | "compiled"> | undefined,
  workflow: Pick<RunRecord, "definitionId">,
): string {
  const nodeId = retry.compiled.invocation.causation?.nodeId ?? "unknown";
  const failure = original?.outcome?.status === "failure" ? original.outcome.failure : undefined;
  const reason = failure ? ` after ${failure.code}: ${failure.message}` : "";
  const changes = changedLimits(retry.compiled.limits, original?.compiled.limits);
  const limits = changes ? ` Adjusted limits: ${JSON.stringify(changes)}.` : "";
  return `${workflow.definitionId} state ${nodeId} is retrying${reason}.${limits} Completed workflow states are retained.`;
}

export function summarizeWorkflowTerminal(
  run: Pick<RunRecord, "id" | "definitionId" | "outcome">,
  recoveryAttempted: boolean,
): string {
  if (run.outcome?.status !== "failure") {
    return `${run.definitionId} run ${run.id} reached a terminal state.`;
  }
  const failure = run.outcome.failure;
  const cause = failure.causeRunId ? ` Cause: ${failure.causeRunId}.` : "";
  const recovery = recoveryAttempted
    ? " failed after its declared recovery policy was exhausted"
    : " failed";
  return `${run.definitionId}${recovery} [${failure.code}]: ${failure.message}.${cause} Completed states were not rerun. Do not restart the full workflow automatically.`;
}

function changedLimits(
  current: RunRecord["compiled"]["limits"],
  previous: RunRecord["compiled"]["limits"] | undefined,
): Record<string, unknown> | undefined {
  if (!previous) return undefined;
  const changes = Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(current)])]
      .map((key) => key as keyof typeof current)
      .filter((key) => current[key] !== previous[key])
      .map((key) => [key, current[key] ?? null]),
  );
  return Object.keys(changes).length > 0 ? changes : undefined;
}

export function summarizeTerminal(outcome: unknown, runId: RunId, retryOf?: RunId): string {
  const value = outcome as
    | { readonly status: "success"; readonly value: unknown }
    | {
        readonly status: "failure";
        readonly failure: {
          readonly code: string;
          readonly message: string;
          readonly retryable: boolean;
          readonly causeRunId?: RunId;
          readonly details?: {
            readonly category?: string;
            readonly requestedTools?: readonly string[];
            readonly suggestedLimits?: unknown;
          };
        };
      }
    | { readonly status: "cancelled"; readonly reason: string }
    | undefined;
  const prefix = retryOf ? `Recovery run ${runId} for ${retryOf}` : `Run ${runId}`;
  if (!value) return `${prefix} reached a terminal state.`;
  if (value.status === "failure") {
    const cause = value.failure.causeRunId ? ` Cause: ${value.failure.causeRunId}.` : "";
    const category = value.failure.details?.category
      ? ` Category: ${value.failure.details.category}.`
      : "";
    const requestedTools = value.failure.details?.requestedTools?.length
      ? ` Requested tools: ${value.failure.details.requestedTools.join(", ")}.`
      : "";
    const suggestedLimits = value.failure.details?.suggestedLimits
      ? ` Suggested limits: ${JSON.stringify(value.failure.details.suggestedLimits)}.`
      : "";
    const recovery = value.failure.retryable
      ? " A bounded retry may be appropriate after inspecting the report."
      : " The failure is marked non-retryable; choose another route or ask the user before forcing recovery.";
    const punctuation = /[.!?]$/.test(value.failure.message) ? "" : ".";
    return `${prefix} failed [${value.failure.code}]: ${value.failure.message}${punctuation}${cause}${category}${requestedTools}${suggestedLimits}${recovery}`;
  }
  if (value.status === "cancelled") return `${prefix} was cancelled: ${value.reason}`;
  const summary =
    typeof value.value === "object" &&
    value.value !== null &&
    typeof (value.value as { summary?: unknown }).summary === "string"
      ? (value.value as { summary: string }).summary
      : "completed successfully";
  return `${prefix} completed: ${summary}. Use phenix_handle to inspect the full outcome.`;
}
