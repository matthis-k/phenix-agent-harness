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

/* biome-ignore-all lint/suspicious/noExplicitAny: Pi SDK compatibility adapter. */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BudgetGuard, budgetViolationToError } from "./budget-guard.ts";
import { buildChildSystemPrompt } from "./child-session-prompt.ts";
import {
  buildChildResourceLoaderOptions,
  inferChildIntegrationRefs,
  loadPersona,
  resolveChildExtensionFactories,
  resolveChildSkillPaths,
} from "./child-session-resources.ts";
import type {
  ChildCycleOutcome,
  ChildRun,
  ChildRunId,
  ChildSessionBackend,
  ChildSessionEvent,
  ChildSessionNode,
  ChildSessionSpec,
  PiRuntimeServices,
  PiSessionReference,
  SerializedError,
} from "./child-session-types.ts";
import { ChildRuntimeError, serializeError } from "./child-session-types.ts";
import { createCompletionTool } from "./completion-tool.ts";
import { isFailureEvent, normalizePiEvent } from "./session-event-normalizer.ts";

function abortErrorFromSignal(signal: AbortSignal, fallbackMessage: string): ChildRuntimeError {
  const reason = signal.reason;
  if (reason instanceof ChildRuntimeError) return reason;

  return new ChildRuntimeError(
    "ABORTED",
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.length > 0
        ? reason
        : fallbackMessage,
  );
}

// ── PiSessionLike — injectable session interface for testing ────────────────

export interface PromptOptions {
  readonly streamingBehavior?: "steer" | "followUp";
  readonly preflightResult?: (success: boolean) => void;
}

export interface PiSessionLike {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly isStreaming: boolean;

  prompt(text: string, options?: PromptOptions): Promise<void>;

  followUp(text: string): Promise<void>;
  steer(text: string): Promise<void>;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  abort(): Promise<void>;
  dispose(): void;
}

// ── Prepared Pi session spec ────────────────────────────────────────────────

export interface PreparedPiSessionSpec {
  readonly cwd: string;
  readonly model: Model<any>;
  readonly agentDir: string;
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
  create(spec: PreparedPiSessionSpec): Promise<PiSessionLike>;
}

// ── Production session factory ──────────────────────────────────────────────

/**
 * Production factory that wraps createAgentSession().
 */
export class ProductionPiSessionFactory implements PiSessionFactory {
  async create(spec: PreparedPiSessionSpec): Promise<PiSessionLike> {
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      model: spec.model,
      agentDir: spec.agentDir,
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

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    await this.session.prompt(text, options as any);
  }

  async followUp(text: string): Promise<void> {
    await this.session.followUp(text);
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text);
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
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
  private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
  private readonly budgetGuard: BudgetGuard;
  private readonly startTime = new Date().toISOString();

  private status: ChildSessionNode["status"] = "running";
  private cycle = 0;
  private currentCycle:
    | {
        readonly number: number;
        readonly promise: Promise<ChildCycleOutcome>;
        readonly resolve: (outcome: ChildCycleOutcome) => void;
        error?: SerializedError;
      }
    | undefined;
  private lastCycleOutcome: ChildCycleOutcome = {
    cycle: 0,
    status: "settled",
  };
  private disposed = false;
  private unsub: (() => void) | undefined;
  private readonly boundSignals = new WeakSet<AbortSignal>();
  private lastAssistantText: string | undefined;

  constructor(session: PiSessionLike, spec: ChildSessionSpec, budgetGuard: BudgetGuard) {
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
      const { violation, softWarning } = this.budgetGuard.observe(event);

      if (violation) {
        void this.failAndAbort(budgetViolationToError(violation));
        return;
      }

      this.emit(event);

      if (softWarning) {
        this.emit({
          type: "agent.event",
          runId: this.id,
          event: { type: "budget_soft_warning", message: softWarning },
        });
        // A soft budget warning must reach the model, not only observers.
        void this.session.steer(softWarning).catch(() => undefined);
      }
    }

    if (isFailureEvent(raw as unknown as { type: string })) {
      if (this.currentCycle) {
        this.currentCycle.error = serializeError(raw);
      }
    }

    // agent_settled is Pi's authoritative overall idle boundary. turn_end
    // and agent_end may be followed by retries, compaction, or continuations.
    const rawType = (raw as unknown as { type: string }).type;
    if (rawType === "agent_settled") {
      this.settleCycle();
    }
  };

  private beginCycle(): {
    readonly number: number;
    readonly promise: Promise<ChildCycleOutcome>;
    readonly resolve: (outcome: ChildCycleOutcome) => void;
    error?: SerializedError;
  } {
    if (this.currentCycle) {
      throw new ChildRuntimeError(
        "SESSION_START_FAILED",
        `Child session ${this.id} already has an active cycle.`,
      );
    }

    this.status = "running";
    this.cycle++;
    let resolve!: (outcome: ChildCycleOutcome) => void;
    const promise = new Promise<ChildCycleOutcome>((r) => {
      resolve = r;
    });
    const cycle = {
      number: this.cycle,
      promise,
      resolve,
    };
    this.currentCycle = cycle;
    return cycle;
  }

  private settleCycle(): void {
    const cycle = this.currentCycle;
    if (!cycle) return;

    const outcome: ChildCycleOutcome = {
      cycle: cycle.number,
      status: cycle.error ? "failed" : "settled",
      ...(this.lastAssistantText ? { lastAssistantText: this.lastAssistantText } : {}),
      ...(cycle.error ? { error: cycle.error } : {}),
    };

    this.currentCycle = undefined;
    this.lastCycleOutcome = outcome;
    this.status = outcome.status === "failed" ? "failed" : "settled";
    this.emit({
      type: "cycle.settled",
      runId: this.id,
      cycle: cycle.number,
    });
    cycle.resolve(outcome);
  }

  private completeCycle(outcome: ChildCycleOutcome): void {
    const cycle = this.currentCycle;
    this.currentCycle = undefined;
    this.lastCycleOutcome = outcome;
    if (cycle) cycle.resolve(outcome);
  }

  private async failAndAbort(error: ChildRuntimeError): Promise<void> {
    if (this.disposed || this.status === "failed") return;

    this.status = "failed";
    const serialized = serializeError(error);
    this.emit({
      type: "session.failed",
      runId: this.id,
      error: serialized,
    });
    this.completeCycle({
      cycle: this.currentCycle?.number ?? this.cycle,
      status: "failed",
      error: serialized,
    });

    try {
      await this.session.abort();
    } catch {
      // Best-effort provider abort.
    }
  }

  private bindSignal(signal?: AbortSignal): void {
    if (!signal || this.boundSignals.has(signal)) return;
    this.boundSignals.add(signal);

    const abortFromSignal = (): void => {
      const error = abortErrorFromSignal(signal, "Cancelled by parent.");

      // Preserve typed runtime failures such as TIMEOUT. Ordinary parent
      // cancellation remains a cancelled outcome rather than a failed one.
      if (error.code === "ABORTED") {
        void this.abort(error.message);
      } else {
        void this.failAndAbort(error);
      }
    };

    if (signal.aborted) {
      abortFromSignal();
      return;
    }

    signal.addEventListener("abort", abortFromSignal, { once: true });
  }

  /**
   * Start an idle-session prompt and resolve once Pi accepts it. The full
   * prompt promise remains detached and is completed by agent_settled.
   */
  private async dispatchPrompt(message: string): Promise<void> {
    let preflightSeen = false;
    let accept!: () => void;
    let reject!: (error: unknown) => void;
    const accepted = new Promise<void>((resolve, rejectPromise) => {
      accept = resolve;
      reject = rejectPromise;
    });

    const fullRun = this.session.prompt(message, {
      preflightResult: (success) => {
        preflightSeen = true;
        if (success) {
          accept();
        } else {
          reject(
            new ChildRuntimeError("PROMPT_REJECTED", "Prompt was rejected by the Pi session."),
          );
        }
      },
    });

    void fullRun.then(
      () => {
        // Test doubles may not implement preflightResult. In that case,
        // accepting after full completion is conservative and deterministic.
        if (!preflightSeen) accept();
      },
      (error) => {
        if (!preflightSeen) reject(error);
        void this.failAndAbort(
          new ChildRuntimeError(
            "PROVIDER_FAILED",
            error instanceof Error ? error.message : String(error),
            { cause: error },
          ),
        );
      },
    );

    await accepted;
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
      ...(this.spec.workflowBinding ? { workflowBinding: this.spec.workflowBinding } : {}),
      backend: "sdk",
      pi: this.pi,
      status: this.status,
      startedAt: this.startTime,
    };
  }

  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async continue(message: string, signal?: AbortSignal): Promise<ChildCycleOutcome> {
    if (this.disposed || this.status === "failed" || this.status === "cancelled") {
      throw new ChildRuntimeError("ABORTED", `Child session is ${this.status}.`);
    }
    if (signal?.aborted) {
      const error = abortErrorFromSignal(signal, "Cancelled by parent.");
      if (error.code === "ABORTED") {
        await this.abort(error.message);
      } else {
        await this.failAndAbort(error);
      }
      throw error;
    }

    const cycle = this.beginCycle();
    this.bindSignal(signal);

    try {
      if (this.session.isStreaming) {
        await this.session.followUp(message);
      } else {
        await this.dispatchPrompt(message);
      }
    } catch (error) {
      await this.failAndAbort(
        error instanceof ChildRuntimeError
          ? error
          : new ChildRuntimeError(
              "PROMPT_REJECTED",
              error instanceof Error ? error.message : String(error),
              { cause: error },
            ),
      );
    }

    const outcome = await cycle.promise;
    this.pi = {
      sessionId: this.session.sessionId,
      ...(this.session.sessionFile ? { sessionFile: this.session.sessionFile } : {}),
    };
    return outcome;
  }

  async waitForCurrentCycle(signal?: AbortSignal): Promise<ChildCycleOutcome> {
    this.bindSignal(signal);
    return this.currentCycle?.promise ?? this.lastCycleOutcome;
  }

  async abort(reason: string): Promise<void> {
    if (this.disposed || this.status === "cancelled") return;
    this.status = "cancelled";

    try {
      await this.session.abort();
    } catch {
      // Best-effort abort.
    }

    this.completeCycle({
      cycle: this.currentCycle?.number ?? this.cycle,
      status: "cancelled",
      error: {
        code: "ABORTED",
        message: reason,
      },
    });
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

    this.emit({
      type: "session.disposed",
      runId: this.id,
    });
    this.listeners.clear();
  }

  // ── Setup ────────────────────────────────────────────────────────────

  /**
   * Start the initial prompt. Called once after construction.
   * Returns once the prompt has been accepted (preflightResult),
   * not after full settlement.
   */
  async startInitialPrompt(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw abortErrorFromSignal(signal, "Cancelled by parent.");
    }

    this.unsub = this.session.subscribe(this.handlePiEvent);
    this.beginCycle();
    this.bindSignal(signal);

    await this.dispatchPrompt(this.spec.initialPrompt);

    this.emit({
      type: "session.started",
      runId: this.id,
      pi: this.pi,
    });
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
    | ((spec: ChildSessionSpec, systemPrompt: string) => DefaultResourceLoader)
    | undefined;
  private readonly buildSystemPromptFn: ((spec: ChildSessionSpec) => string) | undefined;

  constructor(options: SdkChildSessionBackendOptions) {
    this.services = options.services;
    this.sessionFactory = options.sessionFactory ?? new ProductionPiSessionFactory();
    this.buildCustomToolsFn = options.buildCustomTools;
    this.buildResourceLoaderFn = options.buildResourceLoader;
    this.buildSystemPromptFn = options.buildSystemPrompt;
  }

  async start(spec: ChildSessionSpec, signal: AbortSignal): Promise<ChildRun> {
    // 1. Resolve the concrete model from the shared registry.
    const modelRegistry = this.services.modelRegistry as ModelRegistry;
    const model = modelRegistry.find(spec.model.provider, spec.model.id);

    if (!model) {
      throw new ChildRuntimeError(
        "MODEL_NOT_FOUND",
        `Configured child model ${spec.model.provider}/${spec.model.id} is unavailable.`,
      );
    }

    // 2. Build the deterministic contract/persona/workflow system prompt.
    const systemPrompt = this.buildSystemPromptFn
      ? this.buildSystemPromptFn(spec)
      : buildChildSystemPrompt({
          persona: loadPersona(spec.role),
          contract: spec.contract,
          workflowProjection: spec.workflowProjection,
        });

    // 3. Build the isolated resource loader.
    const resourceLoader = this.buildResourceLoaderFn
      ? this.buildResourceLoaderFn(spec, systemPrompt)
      : await this.buildDefaultResourceLoader(spec, systemPrompt);

    // 4. Every SDK child gets its own closure-bound completion tool.
    // Contract-derived workflow and task tools are supplied by the composition root.
    const customTools: readonly ToolDefinition[] = [
      createCompletionTool(spec.contractChannel) as unknown as ToolDefinition,
      ...(this.buildCustomToolsFn ? this.buildCustomToolsFn(spec) : []),
    ];

    // 5. Build the tool allowlist.
    const toolNames = buildEffectiveToolNames(spec);

    // 6. Build session manager.
    const sessionManager =
      spec.persistence === "memory"
        ? SessionManager.inMemory(spec.cwd)
        : SessionManager.create(spec.cwd);

    // 7. Build settings manager.
    const settingsManager = SettingsManager.create(spec.cwd, this.services.agentDir);

    // 8. Create the session.
    const preparedSpec: PreparedPiSessionSpec = {
      cwd: spec.cwd,
      model,
      agentDir: this.services.agentDir,
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
      // Total timeout ownership belongs to the coordinator so the same
      // deadline covers model execution, verification, and critic execution.
      timeoutMs: 0,
    });

    // 10. Create the run.
    const run = new SdkChildRun(session, spec, budgetGuard);

    // 11. Subscribe before prompting and start the initial prompt.
    try {
      await run.startInitialPrompt(signal);
    } catch (error) {
      await run.dispose();
      throw error;
    }

    // 12. Return the live run once the prompt has been accepted.
    return run;
  }

  private async buildDefaultResourceLoader(
    spec: ChildSessionSpec,
    systemPrompt: string,
  ): Promise<DefaultResourceLoader> {
    const integrationRefs = inferChildIntegrationRefs(spec.effectiveTools, spec.extensionRefs);
    const extensionFactories = await resolveChildExtensionFactories(integrationRefs);
    const skillPaths = resolveChildSkillPaths(spec.skillRefs, this.services.agentDir);

    const loader = new DefaultResourceLoader(
      buildChildResourceLoaderOptions({
        spec,
        agentDir: this.services.agentDir,
        systemPrompt,
        extensionFactories,
        skillPaths,
      }),
    );
    await loader.reload();
    return loader;
  }
}

// ── Effective tool names ────────────────────────────────────────────────────

/**
 * Build the deterministic tool allowlist.
 *
 * Includes effective task tools plus the current runtime-owned completion,
 * workflow, and task-tree capabilities. Unmanaged delegation is never exposed
 * to a child.
 */
export function buildEffectiveToolNames(spec: ChildSessionSpec): readonly string[] {
  const runtimeTools = new Set(["subagent", "phenix_complete", "phenix_tasks", "phenix_workflow"]);
  const baseTools = spec.effectiveTools.filter((tool) => !runtimeTools.has(tool));

  return [...new Set([...baseTools, "phenix_complete", "phenix_tasks", "phenix_workflow"])].sort();
}
