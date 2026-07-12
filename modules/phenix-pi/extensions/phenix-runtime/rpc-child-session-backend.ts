/**
 * rpc-child-session-backend — process-isolation adapter
 *
 * Implements ChildSessionBackend against the public RpcClient export.
 * Does not write a custom JSON parser, request-correlation protocol,
 * event bus, or process manager. RpcClient already provides:
 *   process startup, strict JSONL, request IDs, prompt, followUp, steer,
 *   abort, getState, waitForIdle, event subscription, shutdown.
 *
 * The RPC backend implements the same ChildSessionBackend and ChildRun
 * interfaces as the SDK backend.
 *
 * RPC scope: leaf-session-only. Nested delegation is not supported because
 * it would require recreating a second proprietary control protocol.
 * Fail closed during linking or session preparation if nested delegation
 * is requested.
 */

import type {
  AgentEvent,
} from "@earendil-works/pi-agent-core";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";

import type {
  ChildCycleOutcome,
  ChildRun,
  ChildRunId,
  ChildSessionBackend,
  ChildSessionEvent,
  ChildSessionNode,
  ChildSessionSpec,
  PiSessionReference,
  SerializedError,
} from "./child-session-types.ts";
import {
  ChildRuntimeError,
  serializeError,
} from "./child-session-types.ts";
import {
  normalizePiEvent,
} from "./session-event-normalizer.ts";
import {
  BudgetGuard,
  budgetViolationToError,
} from "./budget-guard.ts";

// ── RpcClientLike — injectable interface for unit tests ─────────────────────

export interface RpcClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<RpcSessionStateLike>;
  waitForIdle(timeout?: number): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

export interface RpcSessionStateLike {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly isStreaming: boolean;
}

// ── RpcClient factory ───────────────────────────────────────────────────────

export interface RpcClientFactory {
  create(options: RpcClientOptions): RpcClientLike;
}

export class ProductionRpcClientFactory implements RpcClientFactory {
  create(options: RpcClientOptions): RpcClientLike {
    return new RpcClientAdapter(new RpcClient(options));
  }
}

class RpcClientAdapter implements RpcClientLike {
  private readonly client: RpcClient;

  constructor(client: RpcClient) {
    this.client = client;
  }

  async start(): Promise<void> {
    await this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  async prompt(message: string): Promise<void> {
    await this.client.prompt(message);
  }

  async followUp(message: string): Promise<void> {
    await this.client.followUp(message);
  }

  async steer(message: string): Promise<void> {
    await this.client.steer(message);
  }

  async abort(): Promise<void> {
    await this.client.abort();
  }

  async getState(): Promise<RpcSessionStateLike> {
    const state = await this.client.getState();
    return {
      sessionId: state.sessionId,
      ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
      isStreaming: state.isStreaming,
    };
  }

  async waitForIdle(timeout?: number): Promise<void> {
    await this.client.waitForIdle(timeout);
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.client.onEvent(listener);
  }
}

// ── RPC child run ───────────────────────────────────────────────────────────

class RpcChildRun implements ChildRun {
  readonly id: ChildRunId;
  readonly backend = "rpc" as const;
  pi: PiSessionReference;

  private readonly client: RpcClientLike;
  private readonly spec: ChildSessionSpec;
  private readonly listeners = new Set<
    (event: ChildSessionEvent) => void
  >();
  private readonly budgetGuard: BudgetGuard;
  private readonly startTime = new Date().toISOString();

  private status: ChildSessionNode["status"] = "running";
  private cycle = 0;
  private currentCycleResolve:
    | ((outcome: ChildCycleOutcome) => void)
    | undefined;
  private currentCycleReject:
    | ((error: unknown) => void)
    | undefined;
  private currentCycleError: SerializedError | undefined;
  private disposed = false;
  private unsub: (() => void) | undefined;

  constructor(
    client: RpcClientLike,
    spec: ChildSessionSpec,
    budgetGuard: BudgetGuard,
    piRef: PiSessionReference,
  ) {
    this.client = client;
    this.spec = spec;
    this.id = spec.id;
    this.budgetGuard = budgetGuard;
    this.pi = piRef;
  }

  private handleRpcEvent = (raw: AgentEvent): void => {
    if (this.disposed) return;

    const normalized = normalizePiEvent(
      this.id,
      raw as unknown as { type: string },
    );

    for (const event of normalized) {
      const { violation, softWarning } = this.budgetGuard.observe(event);

      if (violation) {
        const error = budgetViolationToError(violation);
        this.failCycle(serializeError(error));
        this.emit({
          type: "session.failed",
          runId: this.id,
          error: serializeError(error),
        });
        return;
      }

      this.emit(event);

      if (softWarning) {
        this.emit({
          type: "agent.event",
          runId: this.id,
          event: { type: "budget_soft_warning", message: softWarning },
        });
      }
    }

    // Settlement — agent_end resolves the current cycle (RPC waitForIdle uses agent_end)
    const rawType = (raw as unknown as { type: string }).type;
    if (rawType === "turn_end") {
      this.settleCycle();
    }
    if (rawType === "agent_end") {
      const willRetry = (raw as unknown as { willRetry?: boolean }).willRetry;
      if (!willRetry) {
        this.settleCycle();
      }
    }
  };

  private settleCycle(): void {
    if (this.currentCycleResolve) {
      const outcome: ChildCycleOutcome = {
        cycle: this.cycle,
        status: this.currentCycleError ? "failed" : "settled",
        ...(this.currentCycleError
          ? { error: this.currentCycleError }
          : {}),
      };
      const resolve = this.currentCycleResolve;
      this.currentCycleResolve = undefined;
      this.currentCycleReject = undefined;
      this.currentCycleError = undefined;
      this.emit({
        type: "cycle.settled",
        runId: this.id,
        cycle: this.cycle,
      });
      resolve(outcome);
    }
  }

  private failCycle(error: SerializedError): void {
    this.currentCycleError = error;
    if (this.currentCycleReject) {
      const reject = this.currentCycleReject;
      this.currentCycleResolve = undefined;
      this.currentCycleReject = undefined;
      reject(new ChildRuntimeError(error.code as any, error.message));
    } else if (this.currentCycleResolve) {
      this.settleCycle();
    }
  }

  private emit(event: ChildSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must not crash the run.
      }
    }
  }

  snapshot(): ChildSessionNode {
    return {
      id: this.id,
      ...(this.spec.parentId ? { parentId: this.spec.parentId } : {}),
      rootId: this.spec.rootId,
      handleId: this.spec.handleId,
      role: this.spec.role,
      agentClient: this.spec.agentClient,
      model: this.spec.model,
      thinkingLevel: this.spec.thinkingLevel,
      contractId: this.spec.contract.id,
      ...(this.spec.workflowBinding
        ? { workflowBinding: this.spec.workflowBinding }
        : {}),
      backend: "rpc",
      pi: this.pi,
      status: this.status,
      startedAt: this.startTime,
    };
  }

  subscribe(
    listener: (event: ChildSessionEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async continue(
    message: string,
    signal?: AbortSignal,
  ): Promise<ChildCycleOutcome> {
    if (this.disposed) {
      throw new ChildRuntimeError(
        "ABORTED",
        "Child session has been disposed.",
      );
    }

    this.cycle++;
    this.currentCycleError = undefined;

    const cyclePromise = new Promise<ChildCycleOutcome>(
      (resolve, reject) => {
        this.currentCycleResolve = resolve;
        this.currentCycleReject = reject;
      },
    );

    try {
      // RPC: check if streaming via getState
      const state = await this.client.getState();
      if (state.isStreaming) {
        await this.client.followUp(message);
      } else {
        await this.client.prompt(message);
      }
    } catch (error) {
      this.failCycle(serializeError(error));
    }

    if (signal) {
      if (signal.aborted) {
        await this.abort("cancelled by parent");
        throw new ChildRuntimeError("ABORTED", "Cancelled by parent.");
      }
      signal.addEventListener(
        "abort",
        () => {
          this.abort("cancelled by parent").catch(() => undefined);
        },
        { once: true },
      );
    }

    return cyclePromise;
  }

  async waitForCurrentCycle(
    signal?: AbortSignal,
  ): Promise<ChildCycleOutcome> {
    if (this.currentCycleResolve) {
      const cyclePromise = new Promise<ChildCycleOutcome>(
        (resolve, reject) => {
          this.currentCycleResolve = resolve;
          this.currentCycleReject = reject;
        },
      );

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            this.abort("cancelled by parent").catch(() => undefined);
          },
          { once: true },
        );
      }

      return cyclePromise;
    }

    return {
      cycle: this.cycle,
      status: "settled",
    };
  }

  async abort(reason: string): Promise<void> {
    if (this.disposed) return;
    try {
      await this.client.abort();
    } catch {
      // Best-effort.
    }
    this.status = "cancelled";
    if (this.currentCycleReject) {
      const reject = this.currentCycleReject;
      this.currentCycleResolve = undefined;
      this.currentCycleReject = undefined;
      reject(new ChildRuntimeError("ABORTED", reason));
    }
    this.emit({
      type: "session.cancelled",
      runId: this.id,
      reason,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.status = "disposed";

    try {
      this.unsub?.();
    } catch {
      // Best-effort.
    }

    try {
      await this.client.stop();
    } catch {
      // Best-effort.
    }

    this.listeners.clear();
    this.emit({
      type: "session.disposed",
      runId: this.id,
    });
  }

  async startInitial(signal: AbortSignal): Promise<void> {
    // Subscribe before prompting.
    this.unsub = this.client.onEvent(this.handleRpcEvent);

    this.cycle = 1;

    const cyclePromise = new Promise<ChildCycleOutcome>(
      (resolve, reject) => {
        this.currentCycleResolve = resolve;
        this.currentCycleReject = reject;
      },
    );

    try {
      await this.client.prompt(this.spec.initialPrompt);
    } catch (error) {
      throw new ChildRuntimeError(
        "PROMPT_REJECTED",
        `Initial prompt was rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Resolve session reference from state.
    try {
      const state = await this.client.getState();
      this.pi = {
        sessionId: state.sessionId,
        ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
      };
    } catch {
      // getState may not be ready immediately — keep the initial reference.
    }

    signal.addEventListener(
      "abort",
      () => {
        this.abort("cancelled by parent").catch(() => undefined);
      },
      { once: true },
    );

    this._initialCyclePromise = cyclePromise;
  }

  private _initialCyclePromise: Promise<ChildCycleOutcome> | undefined;

  getInitialCyclePromise(): Promise<ChildCycleOutcome> | undefined {
    return this._initialCyclePromise;
  }
}

// ── RPC child session backend ───────────────────────────────────────────────

export interface RpcChildSessionBackendOptions {
  readonly rpc?: {
    readonly cliPath?: string;
    readonly sessionDirectory?: string;
    readonly childExtensionPath?: string;
  };
  readonly clientFactory?: RpcClientFactory;
}

export class RpcChildSessionBackend implements ChildSessionBackend {
  readonly kind = "rpc" as const;

  private readonly options: RpcChildSessionBackendOptions;
  private readonly clientFactory: RpcClientFactory;

  constructor(options: RpcChildSessionBackendOptions = {}) {
    this.options = options;
    this.clientFactory =
      options.clientFactory ?? new ProductionRpcClientFactory();
  }

  async start(
    spec: ChildSessionSpec,
    signal: AbortSignal,
  ): Promise<ChildRun> {
    // RPC cannot receive closure-bound custom tools through the command
    // protocol. Until childExtensionPath is implemented as a complete,
    // contract-specific bootstrap extension, fail closed instead of starting
    // a process that cannot submit or enforce its contract.
    throw new ChildRuntimeError(
      "RPC_CONTRACT_RUNTIME_UNAVAILABLE",
      "RPC child sessions are disabled until the contract-bound child extension bootstrap is implemented. Use runtime.childSessionBackend = \"sdk\".",
    );

    // Leaf-only restriction: fail closed if nested delegation is requested.
    if (spec.contract.runtime.delegation.remainingDepth > 0) {
      throw new ChildRuntimeError(
        "RPC_NESTED_DELEGATION_UNSUPPORTED",
        "RPC child sessions are currently leaf-only. " +
        "Nested delegation through RPC is not supported.",
      );
    }

    // Build RPC client options. Environment passed through env is
    // child-process-local — that is acceptable.
    const rpcOpts: RpcClientOptions = {
      cwd: spec.cwd,
      provider: spec.model.provider,
      model: spec.model.id,
      ...(this.options.rpc?.cliPath
        ? { cliPath: this.options.rpc.cliPath }
        : {}),
      // No process.env mutation — env is child-process-local only.
    };

    const client = this.clientFactory.create(rpcOpts);

    try {
      await client.start();
    } catch (error) {
      throw new ChildRuntimeError(
        "SESSION_START_FAILED",
        `RPC process failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Initial Pi session reference — will be updated after getState.
    const piRef: PiSessionReference = {
      sessionId: `rpc-${spec.id}`,
    };

    const budgetGuard = new BudgetGuard({
      turnBudget: spec.turnBudget,
      toolBudget: spec.toolBudget,
      timeoutMs: spec.timeoutMs,
    });

    const run = new RpcChildRun(client, spec, budgetGuard, piRef);

    await run.startInitial(signal);

    return run;
  }
}
