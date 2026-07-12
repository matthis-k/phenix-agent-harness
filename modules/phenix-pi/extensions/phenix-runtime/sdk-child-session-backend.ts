/**
 * sdk-child-session-backend — default and fully supported child backend
 *
 * Implements ChildSessionBackend using only public exports from
 * @earendil-works/pi-coding-agent.
 *
 * Uses:
 *   createAgentSession
 *   DefaultResourceLoader
 *   SessionManager
 *   SettingsManager
 *   ModelRegistry
 *   defineTool
 *
 * A child session is a real independent AgentSession with its own model
 * context, message history, tools, and prompt — even though it shares
 * the Node process.
 */

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

import type {
  ChildCycleOutcome,
  ChildRun,
  ChildRunId,
  ChildSessionBackend,
  ChildSessionEvent,
  ChildSessionNode,
  ChildSessionSpec,
  PiSessionReference,
  PiRuntimeServices,
  SerializedError,
} from "./child-session-types.ts";
import {
  ChildRuntimeError,
  serializeError,
} from "./child-session-types.ts";
import {
  normalizePiEvent,
  isFailureEvent,
} from "./session-event-normalizer.ts";
import {
  BudgetGuard,
  budgetViolationToError,
} from "./budget-guard.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// ── PiSessionLike — injectable session interface for testing ────────────────

export interface PromptOptions {
  readonly streamingBehavior?: "steer" | "followUp";
  readonly preflightResult?: (success: boolean) => void;
}

export interface PiSessionLike {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly isStreaming: boolean;

  prompt(
    text: string,
    options?: PromptOptions,
  ): Promise<void>;

  followUp(text: string): Promise<void>;
  steer(text: string): Promise<void>;

  subscribe(
    listener: (event: AgentSessionEvent) => void,
  ): () => void;

  abort(): Promise<void>;
  dispose(): void;
}

// ── Prepared Pi session spec ────────────────────────────────────────────────

export interface PreparedPiSessionSpec {
  readonly cwd: string;
  readonly model: Model<any>;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly customTools: readonly ToolDefinition[];
  readonly resourceLoader: DefaultResourceLoader;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly initialPrompt: string;
  readonly persistence: "memory" | "file";
}

// ── Pi session factory ──────────────────────────────────────────────────────

export interface PiSessionFactory {
  create(
    spec: PreparedPiSessionSpec,
  ): Promise<PiSessionLike>;
}

// ── Production session factory ──────────────────────────────────────────────

/**
 * Production factory that wraps createAgentSession().
 */
export class ProductionPiSessionFactory implements PiSessionFactory {
  async create(
    spec: PreparedPiSessionSpec,
  ): Promise<PiSessionLike> {
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      model: spec.model,
      thinkingLevel: spec.thinkingLevel,
      tools: [...spec.tools],
      ...(spec.excludeTools && spec.excludeTools.length > 0
        ? { excludeTools: [...spec.excludeTools] }
        : {}),
      customTools: [...spec.customTools] as any,
      resourceLoader: spec.resourceLoader,
      sessionManager: spec.sessionManager,
      settingsManager: spec.settingsManager,
    });

    return new AgentSessionAdapter(session);
  }
}

// ── AgentSession adapter ────────────────────────────────────────────────────

/**
 * Adapts a Pi AgentSession to the PiSessionLike interface.
 */
class AgentSessionAdapter implements PiSessionLike {
  private readonly session: AgentSession;

  constructor(session: AgentSession) {
    this.session = session;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  async prompt(
    text: string,
    options?: PromptOptions,
  ): Promise<void> {
    await this.session.prompt(text, options as any);
  }

  async followUp(text: string): Promise<void> {
    await this.session.followUp(text);
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text);
  }

  subscribe(
    listener: (event: AgentSessionEvent) => void,
  ): () => void {
    return this.session.subscribe(listener as AgentSessionEventListener);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  dispose(): void {
    this.session.dispose();
  }
}

// ── SDK child run ───────────────────────────────────────────────────────────

class SdkChildRun implements ChildRun {
  readonly id: ChildRunId;
  readonly backend = "sdk" as const;
  pi: PiSessionReference;

  private readonly session: PiSessionLike;
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
  private lastAssistantText: string | undefined;

  constructor(
    session: PiSessionLike,
    spec: ChildSessionSpec,
    budgetGuard: BudgetGuard,
  ) {
    this.session = session;
    this.spec = spec;
    this.id = spec.id;
    this.budgetGuard = budgetGuard;
    this.pi = {
      sessionId: session.sessionId,
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
    };
  }

  // ── Event handling ───────────────────────────────────────────────────

  private handlePiEvent = (raw: AgentSessionEvent): void => {
    if (this.disposed) return;

    const normalized = normalizePiEvent(this.id, raw as unknown as { type: string });

    for (const event of normalized) {
      // Budget guard
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

      // Emit the normalized event
      this.emit(event);

      // Soft warning — emit as agent.event (not a failure)
      if (softWarning) {
        this.emit({
          type: "agent.event",
          runId: this.id,
          event: { type: "budget_soft_warning", message: softWarning },
        });
      }
    }

    // Failure detection
    if (isFailureEvent(raw as unknown as { type: string })) {
      this.currentCycleError = serializeError(raw);
    }

    // Check for agent_end with no retry — treat turn_end as settlement
    const rawType = (raw as unknown as { type: string }).type;
    if (rawType === "turn_end" || rawType === "agent_end") {
      // On agent_end, check willRetry
      if (rawType === "agent_end") {
        const willRetry = (raw as unknown as { willRetry?: boolean }).willRetry;
        if (!willRetry) {
          this.settleCycle();
        }
      } else {
        // turn_end — settle the cycle
        this.settleCycle();
      }
    }
  };

  private settleCycle(): void {
    if (this.currentCycleResolve) {
      const outcome: ChildCycleOutcome = {
        cycle: this.cycle,
        status: this.currentCycleError ? "failed" : "settled",
        ...(this.lastAssistantText
          ? { lastAssistantText: this.lastAssistantText }
          : {}),
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
        // Listener errors are ignored — they must not crash the run.
      }
    }
  }

  // ── ChildRun interface ───────────────────────────────────────────────

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
      backend: "sdk",
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

    // If the session is idle, send a normal prompt.
    // If it is streaming, queue a follow-up.
    try {
      if (this.session.isStreaming) {
        await this.session.followUp(message);
      } else {
        await this.session.prompt(message);
      }
    } catch (error) {
      this.failCycle(serializeError(error));
    }

    // Handle caller cancellation
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

    const outcome = await cyclePromise;

    // Update Pi session reference (may have changed after compaction/branching)
    this.pi = {
      sessionId: this.session.sessionId,
      ...(this.session.sessionFile
        ? { sessionFile: this.session.sessionFile }
        : {}),
    };

    return outcome;
  }

  async waitForCurrentCycle(
    signal?: AbortSignal,
  ): Promise<ChildCycleOutcome> {
    // If there's an active cycle promise, wait for it.
    if (this.currentCycleResolve) {
      const cyclePromise = new Promise<ChildCycleOutcome>(
        (resolve, reject) => {
          const origResolve = this.currentCycleResolve;
          const origReject = this.currentCycleReject;
          this.currentCycleResolve = resolve;
          this.currentCycleReject = reject;
          void origResolve;
          void origReject;
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

    // No active cycle — return immediately as settled.
    return {
      cycle: this.cycle,
      status: "settled",
      ...(this.lastAssistantText
        ? { lastAssistantText: this.lastAssistantText }
        : {}),
    };
  }

  async abort(reason: string): Promise<void> {
    if (this.disposed) return;
    try {
      await this.session.abort();
    } catch {
      // Best-effort abort.
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
      // Best-effort unsubscribe.
    }

    try {
      this.session.dispose();
    } catch {
      // Best-effort dispose.
    }

    this.listeners.clear();
    this.emit({
      type: "session.disposed",
      runId: this.id,
    });
  }

  // ── Setup ────────────────────────────────────────────────────────────

  /**
   * Start the initial prompt. Called once after construction.
   * Returns once the prompt has been accepted (preflightResult),
   * not after full settlement.
   */
  async startInitialPrompt(signal: AbortSignal): Promise<void> {
    // Subscribe before prompting.
    this.unsub = this.session.subscribe(this.handlePiEvent);

    this.cycle = 1;

    const cyclePromise = new Promise<ChildCycleOutcome>(
      (resolve, reject) => {
        this.currentCycleResolve = resolve;
        this.currentCycleReject = reject;
      },
    );

    // Use preflightResult to distinguish prompt acceptance from full settlement.
    let promptRejected = false;

    try {
      await this.session.prompt(this.spec.initialPrompt, {
        preflightResult: (_success: boolean) => {
          if (!_success) {
            promptRejected = true;
          }
        },
      });
    } catch (error) {
      // Prompt threw — the session could not start.
      throw new ChildRuntimeError(
        "PROMPT_REJECTED",
        `Initial prompt was rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // If prompt was explicitly rejected
    if (promptRejected) {
      throw new ChildRuntimeError(
        "PROMPT_REJECTED",
        "Initial prompt was rejected by the session.",
      );
    }

    // Handle caller cancellation
    signal.addEventListener(
      "abort",
      () => {
        this.abort("cancelled by parent").catch(() => undefined);
      },
      { once: true },
    );

    // Store the cycle promise for waitForCurrentCycle.
    // We don't await it here — the caller will use waitForCurrentCycle.
    this._initialCyclePromise = cyclePromise;
  }

  private _initialCyclePromise: Promise<ChildCycleOutcome> | undefined;

  getInitialCyclePromise(): Promise<ChildCycleOutcome> | undefined {
    return this._initialCyclePromise;
  }
}

// ── SDK child session backend ───────────────────────────────────────────────

export interface SdkChildSessionBackendOptions {
  readonly services: PiRuntimeServices;
  readonly sessionFactory?: PiSessionFactory;
  readonly buildCustomTools?: (spec: ChildSessionSpec) => readonly ToolDefinition[];
  readonly buildResourceLoader?: (
    spec: ChildSessionSpec,
    systemPrompt: string,
  ) => DefaultResourceLoader;
  readonly buildSystemPrompt?: (spec: ChildSessionSpec) => string;
}

/**
 * SDK child session backend — default and fully supported.
 *
 * Uses createAgentSession() to create a real independent AgentSession
 * for each child. Reuses Pi's configured model registry — does not create
 * a separate one with separate credentials.
 */
export class SdkChildSessionBackend implements ChildSessionBackend {
  readonly kind = "sdk" as const;

  private readonly services: PiRuntimeServices;
  private readonly sessionFactory: PiSessionFactory;
  private readonly buildCustomToolsFn:
    | ((spec: ChildSessionSpec) => readonly ToolDefinition[])
    | undefined;
  private readonly buildResourceLoaderFn:
    | ((
      spec: ChildSessionSpec,
      systemPrompt: string,
    ) => DefaultResourceLoader)
    | undefined;
  private readonly buildSystemPromptFn:
    | ((spec: ChildSessionSpec) => string)
    | undefined;

  constructor(options: SdkChildSessionBackendOptions) {
    this.services = options.services;
    this.sessionFactory =
      options.sessionFactory ?? new ProductionPiSessionFactory();
    this.buildCustomToolsFn = options.buildCustomTools;
    this.buildResourceLoaderFn = options.buildResourceLoader;
    this.buildSystemPromptFn = options.buildSystemPrompt;
  }

  async start(
    spec: ChildSessionSpec,
    signal: AbortSignal,
  ): Promise<ChildRun> {
    // 1. Resolve the concrete model from the shared registry.
    const modelRegistry = this.services.modelRegistry as ModelRegistry;
    const model = modelRegistry.find(
      spec.model.provider,
      spec.model.id,
    );

    if (!model) {
      throw new ChildRuntimeError(
        "MODEL_NOT_FOUND",
        `Configured child model ${spec.model.provider}/${spec.model.id} is unavailable.`,
      );
    }

    // 2. Build the system prompt.
    const systemPrompt = this.buildSystemPromptFn
      ? this.buildSystemPromptFn(spec)
      : spec.initialPrompt; // fallback — should not happen in production

    // 3. Build the resource loader.
    const resourceLoader = this.buildResourceLoaderFn
      ? this.buildResourceLoaderFn(spec, systemPrompt)
      : await this.buildDefaultResourceLoader(spec, systemPrompt);

    // 4. Build custom tools (closure-bound phenix_complete, phenix_delegate).
    const customTools = this.buildCustomToolsFn
      ? this.buildCustomToolsFn(spec)
      : [];

    // 5. Build the tool allowlist.
    const toolNames = buildEffectiveToolNames(spec);

    // 6. Build session manager.
    const sessionManager =
      spec.persistence === "memory"
        ? SessionManager.inMemory(spec.cwd)
        : SessionManager.create(spec.cwd);

    // 7. Build settings manager.
    const settingsManager = SettingsManager.create(
      spec.cwd,
      this.services.agentDir,
    );

    // 8. Create the session.
    const preparedSpec: PreparedPiSessionSpec = {
      cwd: spec.cwd,
      model,
      thinkingLevel: spec.thinkingLevel,
      tools: toolNames,
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
      initialPrompt: spec.initialPrompt,
      persistence: spec.persistence,
    };

    const session = await this.sessionFactory.create(preparedSpec);

    // 9. Build the budget guard.
    const budgetGuard = new BudgetGuard({
      turnBudget: spec.turnBudget,
      toolBudget: spec.toolBudget,
      timeoutMs: spec.timeoutMs,
    });

    // 10. Create the run.
    const run = new SdkChildRun(session, spec, budgetGuard);

    // 11. Subscribe before prompting and start the initial prompt.
    await run.startInitialPrompt(signal);

    // 12. Return the live run once the prompt has been accepted.
    return run;
  }

  private async buildDefaultResourceLoader(
    spec: ChildSessionSpec,
    systemPrompt: string,
  ): Promise<DefaultResourceLoader> {
    const loader = new DefaultResourceLoader({
      cwd: spec.cwd,
      agentDir: this.services.agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: !spec.inheritProjectContext,
      extensionFactories: [],
      additionalSkillPaths: [],
      systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();
    return loader;
  }
}

// ── Effective tool names ────────────────────────────────────────────────────

/**
 * Build the deterministic tool allowlist.
 *
 * Includes effective tools plus required runtime tools (phenix_complete,
 * phenix_delegate when delegation is legal). Deduplicates and sorts.
 */
export function buildEffectiveToolNames(
  spec: ChildSessionSpec,
): readonly string[] {
  const canDelegate =
    spec.contract.runtime.delegation.remainingDepth > 0 &&
    spec.contract.runtime.delegation.availableRoles.length > 0;

  const toolNames = [
    ...spec.effectiveTools,
    "phenix_complete",
    ...(canDelegate ? ["phenix_delegate"] : []),
  ];

  // Deduplicate and sort for deterministic ordering.
  return [...new Set(toolNames)].sort();
}
