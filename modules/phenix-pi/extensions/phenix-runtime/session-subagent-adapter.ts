/**
 * session-subagent-adapter — bridge the public manager to child sessions
 *
 * A compiler produces one passive SubagentExecutionPlan. The session runtime
 * owns backend translation, while an AcceptanceEngine independently interprets
 * acceptance policy. The adapter owns lifecycle projection and cancellation.
 */

import {
  type ChildRun,
  ChildRuntimeError,
  type ChildSessionEvent,
  type ChildSessionNode,
} from "./child-session-types.ts";
import type {
  AcceptanceEngine,
  SubagentExecutionCompiler,
  SubagentExecutionPlan,
} from "./execution-plan.ts";
import type { SubagentRequest } from "./subagent-api.ts";
import {
  type SubagentCancellation,
  type SubagentEvent,
  type SubagentExecutionAdapter,
  SubagentExecutionError,
  type SubagentHandle,
  type SubagentSnapshot,
  type SubagentStatus,
} from "./subagent-manager.ts";

export interface SubagentSessionSpawner {
  spawn(execution: SubagentExecutionPlan<unknown>, signal?: AbortSignal): Promise<ChildRun>;
}

function statusFromNode(node: ChildSessionNode, terminal?: SubagentStatus): SubagentStatus {
  if (terminal) return terminal;

  switch (node.status) {
    case "starting":
      return "starting";
    case "running":
    case "settled":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "orphaned":
      return "orphaned";
    case "disposed":
      return "failed";
  }
}

function statusForError(error: SubagentExecutionError): SubagentStatus {
  if (error.code === "ABORTED") return "cancelled";
  if (error.code === "ORPHANED_SESSION") return "orphaned";
  return "failed";
}

function projectChildEvent(event: ChildSessionEvent, snapshot: SubagentSnapshot): SubagentEvent {
  switch (event.type) {
    case "session.started":
    case "session.disposed":
      return { type: event.type, snapshot };
    case "agent.event":
      return { type: event.type, snapshot, event: event.event };
    case "tool.started":
      return { type: event.type, snapshot, toolName: event.toolName };
    case "tool.completed":
      return {
        type: event.type,
        snapshot,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "cycle.settled":
      return { type: event.type, snapshot, cycle: event.cycle };
    case "session.failed":
      return {
        type: event.type,
        snapshot,
        error: { code: event.error.code, message: event.error.message },
      };
    case "session.cancelled":
      return { type: event.type, snapshot, reason: event.reason };
  }
}

function normalizeError(
  error: unknown,
  snapshot: SubagentSnapshot,
  fallbackCode = "SUBAGENT_EXECUTION_FAILED",
): SubagentExecutionError {
  if (error instanceof SubagentExecutionError) {
    if (error.snapshot) return error;
    return new SubagentExecutionError(error.code, error.message, {
      cause: error,
      snapshot,
    });
  }

  if (error instanceof ChildRuntimeError) {
    return new SubagentExecutionError(error.code, error.message, {
      cause: error,
      snapshot,
    });
  }

  return new SubagentExecutionError(
    fallbackCode,
    error instanceof Error ? error.message : String(error),
    { cause: error, snapshot },
  );
}

function waitWithoutCancelling<TOutput>(
  promise: Promise<TOutput>,
  signal: AbortSignal | undefined,
  snapshot: () => SubagentSnapshot,
): Promise<TOutput> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      new SubagentExecutionError("ABORTED", "Waiting for the subagent was cancelled.", {
        snapshot: snapshot(),
      }),
    );
  }

  return new Promise<TOutput>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(
        new SubagentExecutionError("ABORTED", "Waiting for the subagent was cancelled.", {
          snapshot: snapshot(),
        }),
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function scopedStartSignal(signal?: AbortSignal): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(signal?.reason);
  };

  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  return {
    signal: controller.signal,
    dispose: () => signal?.removeEventListener("abort", abort),
  };
}

function normalizeCancellation(
  cancellation: string | SubagentCancellation | undefined,
): Required<SubagentCancellation> {
  if (typeof cancellation === "string") {
    return { code: "ABORTED", reason: cancellation };
  }
  return {
    code: cancellation?.code ?? "ABORTED",
    reason: cancellation?.reason ?? "cancelled by caller",
  };
}

class SessionSubagentHandle<TOutput> implements SubagentHandle<TOutput> {
  readonly id: string;

  private readonly run: ChildRun;
  private readonly plan: SubagentExecutionPlan<TOutput>;
  private readonly acceptance: AcceptanceEngine;
  private readonly evaluationController = new AbortController();

  private terminalStatus: SubagentStatus | undefined;
  private terminalError: SubagentExecutionError | undefined;
  private readonly evaluation: Promise<TOutput>;

  constructor(run: ChildRun, plan: SubagentExecutionPlan<TOutput>, acceptance: AcceptanceEngine) {
    this.run = run;
    this.plan = plan;
    this.acceptance = acceptance;
    this.id = run.id;
    this.evaluation = this.evaluate();
    void this.evaluation.catch(() => undefined);
  }

  private async evaluate(): Promise<TOutput> {
    try {
      const value = await this.acceptance.evaluate(
        this.plan.acceptance,
        this.run,
        this.evaluationController.signal,
      );
      if (this.evaluationController.signal.aborted || this.terminalStatus === "cancelled") {
        const reason = this.evaluationController.signal.reason;
        throw reason instanceof SubagentExecutionError
          ? reason
          : new SubagentExecutionError("ABORTED", "Subagent execution was cancelled.", {
              cause: reason,
              snapshot: this.snapshot(),
            });
      }
      if (this.terminalStatus === "failed" || this.terminalStatus === "orphaned") {
        throw (
          this.terminalError ??
          new SubagentExecutionError(
            "INVALID_STATE",
            `Subagent ${this.id} settled in state ${this.terminalStatus}.`,
            { snapshot: this.snapshot() },
          )
        );
      }
      this.terminalStatus = "completed";
      return value;
    } catch (error) {
      const normalized = normalizeError(error, this.snapshot());
      this.terminalError = normalized;
      this.terminalStatus = statusForError(normalized);
      throw normalized;
    }
  }

  private observe(event: ChildSessionEvent): void {
    if (event.type === "session.failed") {
      const error = new SubagentExecutionError(event.error.code, event.error.message, {
        snapshot: this.snapshot(),
      });
      this.terminalError = error;
      this.terminalStatus = "failed";
    }

    if (event.type === "session.cancelled" && !this.terminalError) {
      this.terminalStatus = "cancelled";
    }
  }

  snapshot(): SubagentSnapshot {
    const node = this.run.snapshot();
    return {
      id: node.id,
      status: statusFromNode(node, this.terminalStatus),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      model: node.model,
      thinking: node.thinkingLevel,
      ...(this.terminalError
        ? {
            error: {
              code: this.terminalError.code,
              message: this.terminalError.message,
            },
          }
        : {}),
    };
  }

  poll(): Promise<SubagentSnapshot> {
    return Promise.resolve(this.snapshot());
  }

  result(signal?: AbortSignal): Promise<TOutput> {
    return waitWithoutCancelling(this.evaluation, signal, () => this.snapshot());
  }

  async send(message: string, signal?: AbortSignal): Promise<void> {
    if (message.trim().length === 0) {
      throw new TypeError("Subagent continuation message must be non-empty.");
    }

    const snapshot = this.snapshot();
    if (["completed", "failed", "cancelled", "orphaned"].includes(snapshot.status)) {
      throw new SubagentExecutionError(
        "INVALID_STATE",
        `Cannot continue subagent ${this.id} in state ${snapshot.status}.`,
        { snapshot },
      );
    }

    const continuation = this.run.continue(message);
    void continuation.catch(() => undefined);
    const outcome = await waitWithoutCancelling(continuation, signal, () => this.snapshot());

    if (outcome.status === "failed" || outcome.status === "cancelled") {
      throw normalizeError(
        outcome.error
          ? new ChildRuntimeError(
              outcome.error.code === "ABORTED" ? "ABORTED" : "PROVIDER_FAILED",
              outcome.error.message,
            )
          : new Error(`Subagent continuation ${outcome.status}.`),
        this.snapshot(),
        "CONTINUATION_FAILED",
      );
    }
  }

  async cancel(cancellation?: string | SubagentCancellation): Promise<void> {
    if (this.terminalStatus) return;

    const { code, reason } = normalizeCancellation(cancellation);
    const error = new SubagentExecutionError(code, reason, { snapshot: this.snapshot() });
    this.terminalError = error;
    this.terminalStatus = statusForError(error);
    this.evaluationController.abort(error);

    if (code === "ABORTED") {
      await this.run.abort(reason);
    }
    await this.evaluation.catch(() => undefined);
  }

  subscribe(listener: (event: SubagentEvent) => void): () => void {
    return this.run.subscribe((event) => {
      this.observe(event);
      listener(projectChildEvent(event, this.snapshot()));
    });
  }
}

export interface SessionSubagentExecutionAdapterOptions {
  readonly compiler: SubagentExecutionCompiler;
  readonly acceptance: AcceptanceEngine;
  readonly sessions: SubagentSessionSpawner;
}

export class SessionSubagentExecutionAdapter implements SubagentExecutionAdapter {
  private readonly compiler: SubagentExecutionCompiler;
  private readonly acceptance: AcceptanceEngine;
  private readonly sessions: SubagentSessionSpawner;

  constructor(options: SessionSubagentExecutionAdapterOptions) {
    this.compiler = options.compiler;
    this.acceptance = options.acceptance;
    this.sessions = options.sessions;
  }

  async spawn<TOutput>(
    request: SubagentRequest<TOutput>,
    signal?: AbortSignal,
  ): Promise<SubagentHandle<TOutput>> {
    const start = scopedStartSignal(signal);

    try {
      const plan = await this.compiler.compile(request, start.signal);
      if (start.signal.aborted) {
        throw new SubagentExecutionError("ABORTED", "Subagent creation was cancelled.");
      }

      const run = await this.sessions.spawn(plan, start.signal);
      if (start.signal.aborted) {
        await run.abort("subagent creation was cancelled");
        await run.dispose();
        throw new SubagentExecutionError("ABORTED", "Subagent creation was cancelled.");
      }
      return new SessionSubagentHandle(run, plan, this.acceptance);
    } catch (error) {
      const snapshot: SubagentSnapshot = {
        id: "unstarted",
        status: signal?.aborted ? "cancelled" : "failed",
      };
      throw normalizeError(error, snapshot, "SUBAGENT_START_FAILED");
    } finally {
      start.dispose();
    }
  }
}

export function createSessionSubagentExecutionAdapter(
  options: SessionSubagentExecutionAdapterOptions,
): SessionSubagentExecutionAdapter {
  return new SessionSubagentExecutionAdapter(options);
}
