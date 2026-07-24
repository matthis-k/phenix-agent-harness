import type { DomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
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
 * subscriber: it is the sole owner of descendant terminal, retry, presentation,
 * and parent-attention notification policy.
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

    if (event.type === "run.fact.recorded" && isPresentationFact(event.data)) {
      await this.notifyRoot(formatPresentationNotice(run.id, event.data));
      return;
    }

    const retryOf = run.compiled.invocation.retryOf;
    if (event.type === "run.created" && retryOf) {
      const original = this.store.projection.runs.get(retryOf);
      await this.notifyRoot(summarizeRetryStart(run, original));
      return;
    }

    if (!isTerminalEvent(event.type) || !run.parentId) return;
    const parent = this.store.projection.runs.get(run.parentId);
    if (!parent) return;

    const summary = summarizeTerminal(run.outcome, run.id, retryOf);
    const failed = run.outcome?.status === "failure";
    if (
      failed ||
      retryOf ||
      (run.compiled.invocation.wait === "background" && parent.kind === "root")
    ) {
      await this.notifyRoot(summary);
    }

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

export function summarizeRetryStart(
  retry: Pick<RunRecord, "id" | "compiled">,
  original: Pick<RunRecord, "id" | "compiled"> | undefined,
): string {
  const originalTools = new Set(original?.compiled.tools ?? []);
  const addedTools = retry.compiled.tools.filter((tool) => !originalTools.has(tool));
  const retryLimits = retry.compiled.limits as Readonly<Record<string, unknown>>;
  const originalLimits = original?.compiled.limits as Readonly<Record<string, unknown>> | undefined;
  const changedLimits = originalLimits
    ? Object.fromEntries(
        [...new Set([...Object.keys(originalLimits), ...Object.keys(retryLimits)])]
          .filter((key) => retryLimits[key] !== originalLimits[key])
          .map((key) => [key, retryLimits[key] ?? null]),
      )
    : retryLimits;
  const tools = addedTools.length > 0 ? ` Added tools: ${addedTools.join(", ")}.` : "";
  const limits =
    Object.keys(changedLimits).length > 0
      ? ` Changed limits: ${JSON.stringify(changedLimits)}.`
      : "";
  return `Recovery run ${retry.id} started for failed run ${original?.id ?? "unknown"}.${tools}${limits} The original outcome remains immutable.`;
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
