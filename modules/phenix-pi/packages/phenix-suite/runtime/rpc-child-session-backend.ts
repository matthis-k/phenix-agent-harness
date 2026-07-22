import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BudgetGuard, budgetViolationToError } from "./budget-guard.ts";
import {
  inferChildIntegrationRefs,
  resolveChildSkillPaths,
} from "./child-session-resources.ts";
import type {
  ChildCycleOutcome,
  ChildRun,
  ChildRunId,
  ChildSessionEvent,
  ChildSessionNode,
  ChildSessionSpec,
  PiSessionReference,
  SerializedError,
} from "./child-session-types.ts";
import { ChildRuntimeError, serializeError } from "./child-session-types.ts";
import { RpcJsonlPeer, type RpcEvent } from "./rpc-jsonl-peer.ts";
import {
  isFailureEvent,
  normalizePiEvent,
  providerFailureFromPiEvent,
} from "./session-event-normalizer.ts";
import { findProjectRoot } from "../subagents/handle-store.ts";

interface TaskBoundChildSessionSpec extends ChildSessionSpec {
  readonly runtimeEnvironment?: Readonly<Record<string, string>>;
}

interface RpcState {
  readonly isStreaming: boolean;
  readonly sessionId: string;
  readonly sessionFile?: string;
}

interface ActiveCycle {
  readonly number: number;
  readonly promise: Promise<ChildCycleOutcome>;
  readonly resolve: (outcome: ChildCycleOutcome) => void;
  error?: SerializedError;
}

export type RpcProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface RpcChildSessionBackendOptions {
  readonly agentDir: string;
  readonly command?: string;
  readonly sessionRoot?: string;
  readonly spawnProcess?: RpcProcessSpawner;
  readonly startupTimeoutMs?: number;
}

function abortErrorFromSignal(signal: AbortSignal, fallback: string): ChildRuntimeError {
  const reason = signal.reason;
  if (reason instanceof ChildRuntimeError) return reason;
  return new ChildRuntimeError(
    "ABORTED",
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.length > 0
        ? reason
        : fallback,
  );
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => textFromContent(item))
      .filter((item): item is string => item !== undefined)
      .join("\n")
      .trim();
    return joined || undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text.trim();
  return textFromContent(record.content) ?? textFromContent(record.text);
}

function assistantText(event: RpcEvent): string | undefined {
  const message = event.message;
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return undefined;
  return textFromContent(record.content);
}

function leafAssignment(spec: ChildSessionSpec): boolean {
  return (
    spec.contract.runtime.delegation.remainingDepth <= 0 ||
    spec.contract.runtime.delegation.availableRoles.length === 0
  );
}

function highAssuranceAssignment(spec: ChildSessionSpec): boolean {
  const text = `${spec.contract.assignment.task}\n${spec.contract.assignment.requirements.join("\n")}`;
  return (
    spec.contract.verification.criticRequired ||
    /\b(?:security|auth(?:entication)?|secret|deployment|production|release)\b/i.test(text)
  );
}

function runtimePreference(): "sdk" | "rpc" | undefined {
  const value = process.env.PHENIX_CHILD_BACKEND?.trim().toLowerCase();
  return value === "sdk" || value === "rpc" ? value : undefined;
}

function executableTools(spec: TaskBoundChildSessionSpec): readonly string[] {
  const tools = new Set(
    spec.effectiveTools.filter(
      (tool) => !["phenix_workflow", "phenix_subagent", "phenix_agent"].includes(tool),
    ),
  );
  tools.add("phenix_complete");
  if (spec.runtimeEnvironment?.PHENIX_TASKS_ENDPOINT) tools.add("phenix_tasks");
  return [...tools].sort();
}

function childArgs(input: {
  readonly spec: TaskBoundChildSessionSpec;
  readonly extensionPath: string;
  readonly skillPaths: readonly string[];
  readonly sessionDirectory: string;
}): readonly string[] {
  const { spec } = input;
  const args: string[] = [
    "--mode",
    "rpc",
    "--provider",
    spec.model.provider,
    "--model",
    spec.model.id,
    "--thinking",
    spec.thinkingLevel,
    "--name",
    `phenix:${spec.id}`,
    "--approve",
    "--no-extensions",
    "--extension",
    input.extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--tools",
    executableTools(spec).join(","),
  ];
  if (!spec.inheritProjectContext) args.push("--no-context-files");
  if (spec.persistence === "file") args.push("--session-dir", input.sessionDirectory);
  else args.push("--no-session");
  for (const skillPath of input.skillPaths) args.push("--skill", skillPath);
  return args;
}

class RpcChildRun implements ChildRun {
  readonly id: ChildRunId;
  readonly backend = "rpc" as const;
  pi: PiSessionReference;

  private readonly process: ChildProcessWithoutNullStreams;
  private readonly peer: RpcJsonlPeer;
  private readonly spec: ChildSessionSpec;
  private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
  private readonly budgetGuard: BudgetGuard;
  private readonly startedAt = new Date().toISOString();
  private readonly boundSignals = new WeakSet<AbortSignal>();
  private status: ChildSessionNode["status"] = "starting";
  private cycle = 0;
  private currentCycle: ActiveCycle | undefined;
  private lastCycleOutcome: ChildCycleOutcome = { cycle: 0, status: "settled" };
  private lastAssistantText: string | undefined;
  private lastProviderFailure: SerializedError | undefined;
  private stderr = "";
  private disposed = false;
  private endedAt: string | undefined;
  private readonly unsubscribePeer: () => void;
  private readonly unsubscribePeerErrors: () => void;

  constructor(process: ChildProcessWithoutNullStreams, peer: RpcJsonlPeer, spec: ChildSessionSpec) {
    this.process = process;
    this.peer = peer;
    this.spec = spec;
    this.id = spec.id;
    this.pi = { sessionId: `starting:${spec.id}` };
    this.budgetGuard = new BudgetGuard({
      turnBudget: spec.turnBudget,
      toolBudget: spec.toolBudget,
      timeoutMs: spec.timeoutMs,
    });
    this.unsubscribePeer = peer.subscribe(this.handleRpcEvent);
    this.unsubscribePeerErrors = peer.subscribeErrors((error) => {
      void this.fail(
        new ChildRuntimeError("ORPHANED_SESSION", error.message, { cause: error }),
      );
    });
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_000);
    });
    process.once("error", (error) => {
      void this.fail(
        new ChildRuntimeError("SESSION_START_FAILED", `Pi RPC process failed: ${error.message}`, {
          cause: error,
        }),
      );
    });
    process.once("exit", (code, signal) => {
      if (this.disposed || this.status === "cancelled" || this.status === "disposed") return;
      const detail = [
        `Pi RPC process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`,
        this.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n");
      void this.fail(
        new ChildRuntimeError(
          this.status === "starting" ? "SESSION_START_FAILED" : "ORPHANED_SESSION",
          detail,
        ),
      );
    });
  }

  async initialize(signal: AbortSignal, startupTimeoutMs: number): Promise<void> {
    this.bindSignal(signal);
    const state = await this.peer.command<RpcState>(
      { type: "get_state" },
      { signal, timeoutMs: startupTimeoutMs },
    );
    const data = state.data;
    if (!data || typeof data.sessionId !== "string") {
      throw new ChildRuntimeError("SESSION_START_FAILED", "Pi RPC get_state omitted session identity.");
    }
    this.pi = {
      sessionId: data.sessionId,
      ...(typeof data.sessionFile === "string" ? { sessionFile: data.sessionFile } : {}),
    };
    this.status = "running";
    this.emit({ type: "session.started", runId: this.id, pi: this.pi });
    this.beginCycle();
    await this.peer.command(
      { type: "prompt", message: this.spec.initialPrompt },
      { signal, timeoutMs: startupTimeoutMs },
    );
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
      ...(this.spec.workflowBinding ? { workflowBinding: this.spec.workflowBinding } : {}),
      backend: "rpc",
      pi: this.pi,
      status: this.status,
      startedAt: this.startedAt,
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
    };
  }

  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async continue(message: string, signal?: AbortSignal): Promise<ChildCycleOutcome> {
    if (this.disposed || ["failed", "cancelled", "disposed", "orphaned"].includes(this.status)) {
      throw new ChildRuntimeError("ABORTED", `Child session is ${this.status}.`);
    }
    if (signal?.aborted) throw abortErrorFromSignal(signal, "Cancelled by parent.");
    this.bindSignal(signal);
    const state = await this.peer.command<RpcState>({ type: "get_state" }, { signal });
    if (state.data?.isStreaming) {
      const active = this.currentCycle ?? this.beginCycle();
      await this.peer.command({ type: "steer", message }, { signal });
      return active.promise;
    }
    const cycle = this.beginCycle();
    await this.peer.command({ type: "prompt", message }, { signal });
    return cycle.promise;
  }

  async waitForCurrentCycle(signal?: AbortSignal): Promise<ChildCycleOutcome> {
    this.bindSignal(signal);
    return this.currentCycle?.promise ?? this.lastCycleOutcome;
  }

  async abort(reason: string): Promise<void> {
    if (this.disposed || this.status === "cancelled") return;
    this.status = "cancelled";
    this.endedAt = new Date().toISOString();
    try {
      await this.peer.command({ type: "abort" }, { timeoutMs: 5_000 });
    } catch {
      // Process termination below remains the final cancellation boundary.
    }
    this.completeCycle({
      cycle: this.currentCycle?.number ?? this.cycle,
      status: "cancelled",
      error: { code: "ABORTED", message: reason },
    });
    this.emit({ type: "session.cancelled", runId: this.id, reason });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.status = "disposed";
    this.endedAt = new Date().toISOString();
    this.unsubscribePeer();
    this.unsubscribePeerErrors();
    this.peer.dispose();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (this.process.exitCode === null && this.process.signalCode === null) {
          this.process.kill("SIGKILL");
        }
      }, 2_000);
      timer.unref?.();
    }
    this.emit({ type: "session.disposed", runId: this.id });
    this.listeners.clear();
  }

  private readonly handleRpcEvent = (raw: RpcEvent): void => {
    if (this.disposed || typeof raw.type !== "string") return;
    const text = assistantText(raw);
    if (text) this.lastAssistantText = text;

    const normalized = normalizePiEvent(this.id, raw as { readonly type: string });
    for (const event of normalized) {
      const { violation, softWarning } = this.budgetGuard.observe(event);
      if (violation) {
        void this.fail(budgetViolationToError(violation));
        return;
      }
      this.emit(event);
      if (softWarning) {
        this.emit({
          type: "agent.event",
          runId: this.id,
          event: { type: "budget_soft_warning", message: softWarning },
        });
        void this.peer.command({ type: "steer", message: softWarning }).catch(() => undefined);
      }
    }

    if (isFailureEvent(raw as { readonly type: string })) {
      const failure = providerFailureFromPiEvent(raw as { readonly type: string });
      if (failure) {
        this.lastProviderFailure = failure;
        if (this.currentCycle) this.currentCycle.error = failure;
      }
    }
    if (raw.type === "extension_error") {
      const message = textFromContent(raw.error) ?? textFromContent(raw.message) ?? "Pi extension failed.";
      const failure = { code: "PROVIDER_FAILED", message } satisfies SerializedError;
      if (this.currentCycle) this.currentCycle.error = failure;
    }
    if (raw.type === "agent_settled") this.settleCycle();
  };

  private beginCycle(): ActiveCycle {
    if (this.currentCycle) {
      throw new ChildRuntimeError(
        "SESSION_START_FAILED",
        `Child session ${this.id} already has an active cycle.`,
      );
    }
    this.status = "running";
    this.lastProviderFailure = undefined;
    this.cycle += 1;
    let resolve!: (outcome: ChildCycleOutcome) => void;
    const promise = new Promise<ChildCycleOutcome>((complete) => {
      resolve = complete;
    });
    const cycle: ActiveCycle = { number: this.cycle, promise, resolve };
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
    this.emit({ type: "cycle.settled", runId: this.id, cycle: cycle.number });
    cycle.resolve(outcome);
  }

  private completeCycle(outcome: ChildCycleOutcome): void {
    const cycle = this.currentCycle;
    this.currentCycle = undefined;
    this.lastCycleOutcome = outcome;
    cycle?.resolve(outcome);
  }

  private async fail(error: ChildRuntimeError): Promise<void> {
    if (this.disposed || this.status === "failed" || this.status === "cancelled") return;
    this.status = error.code === "ORPHANED_SESSION" ? "orphaned" : "failed";
    this.endedAt = new Date().toISOString();
    const serialized = serializeError(error);
    this.emit({ type: "session.failed", runId: this.id, error: serialized });
    this.completeCycle({
      cycle: this.currentCycle?.number ?? this.cycle,
      status: "failed",
      ...(this.lastAssistantText ? { lastAssistantText: this.lastAssistantText } : {}),
      error: serialized,
    });
    try {
      this.peer.notify({ type: "abort" });
    } catch {
      // Best effort; process exit recovery remains active.
    }
  }

  private bindSignal(signal?: AbortSignal): void {
    if (!signal || this.boundSignals.has(signal)) return;
    this.boundSignals.add(signal);
    const onAbort = (): void => {
      const error = abortErrorFromSignal(signal, "Cancelled by parent.");
      if (error.code === "ABORTED") void this.abort(error.message);
      else void this.fail(error);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  private emit(event: ChildSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers must not disrupt the isolated runtime.
      }
    }
  }
}

/** Process-isolated Pi runtime for leaf assignments requiring stronger assurance. */
export class RpcChildSessionBackend {
  readonly kind = "rpc" as const;
  private readonly agentDir: string;
  private readonly command: string;
  private readonly sessionRoot: string;
  private readonly spawnProcess: RpcProcessSpawner;
  private readonly startupTimeoutMs: number;

  constructor(options: RpcChildSessionBackendOptions) {
    this.agentDir = options.agentDir;
    this.command = options.command ?? process.env.PHENIX_PI_BINARY?.trim() ?? "pi";
    this.sessionRoot = options.sessionRoot ?? path.join(this.agentDir, "sessions", "phenix-rpc");
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
  }

  supports(spec: ChildSessionSpec): boolean {
    const preference = runtimePreference();
    if (preference === "sdk") return false;
    if (!leafAssignment(spec)) return false;
    return preference === "rpc" || highAssuranceAssignment(spec);
  }

  async start(spec: ChildSessionSpec, signal: AbortSignal): Promise<ChildRun> {
    if (!this.supports(spec)) {
      throw new ChildRuntimeError(
        "SESSION_START_FAILED",
        `RPC backend does not support nested or non-isolated assignment ${spec.id}.`,
      );
    }
    if (signal.aborted) throw abortErrorFromSignal(signal, "Cancelled before RPC child start.");

    const taskBound = spec as TaskBoundChildSessionSpec;
    const projectRoot = findProjectRoot(spec.cwd);
    const contractRoot = path.join(projectRoot, ".phenix-agent-state", "contracts");
    const extensionPath = fileURLToPath(new URL("./rpc-child-extension.ts", import.meta.url));
    const integrationRefs = inferChildIntegrationRefs(spec.effectiveTools, spec.extensionRefs);
    const skillPaths = resolveChildSkillPaths(spec.skillRefs, this.agentDir);
    const sessionDirectory = path.join(this.sessionRoot, String(spec.id));
    fs.mkdirSync(sessionDirectory, { recursive: true });

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...(taskBound.runtimeEnvironment ?? {}),
      PI_CODING_AGENT_DIR: this.agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PHENIX_RPC_CONTRACT_ROOT: contractRoot,
      PHENIX_RPC_CONTRACT_ID: spec.contract.id,
      PHENIX_RPC_EXTENSION_REFS: JSON.stringify(integrationRefs),
    };
    const args = childArgs({ spec: taskBound, extensionPath, skillPaths, sessionDirectory });
    const processHandle = this.spawnProcess(this.command, args, {
      cwd: spec.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const peer = new RpcJsonlPeer(processHandle.stdout, processHandle.stdin);
    const run = new RpcChildRun(processHandle, peer, spec);
    try {
      await run.initialize(signal, this.startupTimeoutMs);
      return run;
    } catch (error) {
      await run.dispose();
      throw error instanceof ChildRuntimeError
        ? error
        : new ChildRuntimeError(
            "SESSION_START_FAILED",
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
    }
  }
}
