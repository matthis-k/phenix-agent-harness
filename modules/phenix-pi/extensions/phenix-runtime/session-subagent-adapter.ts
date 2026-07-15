/**
 * session-subagent-adapter — bridge the public manager to child sessions
 *
 * The compiler owns policy: contracts, workflow bindings, capabilities,
 * verification, critic gates, persistence, and result decoding. The adapter
 * owns mechanism: start one resolved session, project its lifecycle, and expose
 * it through the stable SubagentHandle API.
 */

import type { SubagentRequest } from "./subagent-api.ts";
import {
  ChildRuntimeError,
  type ChildRun,
  type ChildSessionEvent,
  type ChildSessionNode,
} from "./child-session-types.ts";
import {
  type SubagentEvent,
  type SubagentExecutionAdapter,
  SubagentExecutionError,
  type SubagentHandle,
  type SubagentSnapshot,
  type SubagentStatus,
} from "./subagent-manager.ts";
import type { SubagentSessionRequest } from "./subagent-session-runtime.ts";

/** Fully compiled work that can be executed by the child-session mechanism. */
export interface CompiledSubagentExecution<TOutput> {
  readonly session: SubagentSessionRequest;

  /**
   * Own the complete acceptance pipeline for the live run.
   *
   * This is where an implementation waits for structured completion, performs
   * deterministic verification and critic review, accepts the contract, and
   * decodes the final value.
   */
  evaluate(run: ChildRun, signal: AbortSignal): Promise<TOutput>;
}

/** Compile the stable user request into runtime-owned policy and bindings. */
export interface SubagentExecutionCompiler {
  compile<TOutput>(
    request: SubagentRequest<TOutput>,
    signal: AbortSignal,
  ): Promise<CompiledSubagentExecution<TOutput>>;
}

/** Minimal session-runtime port consumed by this adapter. */
export interface SubagentSessionSpawner {
  spawn(request: SubagentSessionRequest, signal?: AbortSignal): Promise<ChildRun>;
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
    if (!controller.signal.aborted) {
      controller.abort(signal?.reason);
    }
  };

  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => signal?.removeEventListener("abort", abort),
  };
}

class SessionSubagentHandle<TOutput> implements SubagentHandle<TOutput> {
  readonly id: string;

  private readonly run: ChildRun;
  private readonly execution: CompiledSubagentExecution<TOutput>;
  private readonly evaluationController = new AbortController();

  private terminalStatus: SubagentStatus | undefined;
  private terminalError: SubagentExecutionError | undefined;
  private readonly evaluation: Promise<TOutput>;

  constructor(run: ChildRun, execution: CompiledSubagentExecution<TOutput>) {
    this.run = run;
    this.execution = execution;
    this.id = run.id;
    this.evaluation = this.evaluate();
    void this.evaluation.catch(() => undefined);
  }

  private async evaluate(): Promise<TOutput> {
    try {
      const value = await this.execution.evaluate(this.run, this.evaluationController.signal);
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

    if (event.type === "session.cancelled") {
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

  async cancel(reason = "cancelled by caller"): Promise<void> {
    if (this.terminalStatus) return;

    this.terminalStatus = "cancelled";
    this.evaluationController.abort(
      new SubagentExecutionError("ABORTED", reason, { snapshot: this.snapshot() }),
    );
    await this.run.abort(reason);
  }

  subscribe(listener: (event: SubagentEvent) => void): () => void {
    return this.run.subscribe((event) => {
      this.observe(event);
      listener({
        type: event.type,
        snapshot: this.snapshot(),
        data: event,
      });
    });
  }
}

export interface SessionSubagentExecutionAdapterOptions {
  readonly compiler: SubagentExecutionCompiler;
  readonly sessions: SubagentSessionSpawner;
}

/** Concrete adapter from the stable manager API to the child-session runtime. */
export class SessionSubagentExecutionAdapter implements SubagentExecutionAdapter {
  private readonly compiler: SubagentExecutionCompiler;
  private readonly sessions: SubagentSessionSpawner;

  constructor(options: SessionSubagentExecutionAdapterOptions) {
    this.compiler = options.compiler;
    this.sessions = options.sessions;
  }

  async spawn<TOutput>(
    request: SubagentRequest<TOutput>,
    signal?: AbortSignal,
  ): Promise<SubagentHandle<TOutput>> {
    const start = scopedStartSignal(signal);

    try {
      const execution = await this.compiler.compile(request, start.signal);
      if (start.signal.aborted) {
        throw new SubagentExecutionError("ABORTED", "Subagent creation was cancelled.");
      }

      const run = await this.sessions.spawn(execution.session, start.signal);
      return new SessionSubagentHandle(run, execution);
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
