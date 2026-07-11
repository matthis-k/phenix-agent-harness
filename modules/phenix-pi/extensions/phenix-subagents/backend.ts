import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "pi-subagents/src/agents/agents.ts";
import { getArtifactsDir } from "pi-subagents/src/shared/artifacts.ts";
import { loadConfig } from "pi-subagents/src/extension/config.ts";
import {
  SUBAGENT_RPC_PROTOCOL_VERSION,
  SUBAGENT_RPC_REQUEST_EVENT,
  subagentRpcReplyEvent,
  type SubagentRpcReplyEnvelope,
} from "pi-subagents/src/extension/rpc.ts";
import {
  createSubagentExecutor,
  type SubagentParamsLike,
} from "pi-subagents/src/runs/foreground/subagent-executor.ts";
import {
  RESULTS_DIR,
  type Details,
  type SubagentState,
} from "pi-subagents/src/shared/types.ts";

export interface AsyncRunReference {
  readonly runId: string;
  readonly asyncDir: string;
}

export interface AsyncResultPayload {
  readonly lifecycleArtifactVersion?: number;
  readonly runId?: string;
  readonly id?: string;
  readonly success?: boolean;
  readonly state?: string;
  readonly error?: string;
  readonly results?: readonly RuntimeChildResult[];
}

export interface RuntimeChildResult {
  readonly agent?: string;
  readonly success?: boolean;
  readonly exitCode?: number | null;
  readonly error?: string;
  readonly output?: string;
  readonly finalOutput?: string;
  readonly structuredOutput?: unknown;
  readonly acceptance?: RuntimeAcceptanceLedger;
  readonly sessionFile?: string;
  readonly transcriptPath?: string;
}

export interface RuntimeAcceptanceLedger {
  readonly status?: string;
  readonly childReportParseError?: string;
  readonly runtimeChecks?: readonly {
    readonly id?: string;
    readonly status?: string;
    readonly message?: string;
  }[];
  readonly verifyRuns?: readonly {
    readonly id?: string;
    readonly command?: string;
    readonly status?: string;
    readonly exitCode?: number | null;
    readonly stderr?: string;
    readonly stdout?: string;
  }[];
  readonly reviewResult?: {
    readonly status?: string;
    readonly findings?: readonly {
      readonly severity?: string;
      readonly file?: string;
      readonly issue?: string;
      readonly rationale?: string;
    }[];
  };
}

interface EventBus {
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
  emit(event: string, payload: unknown): void;
}

interface BackendOptions {
  readonly pi: ExtensionAPI;
}

function createState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    subagentInProgress: false,
    subagentSpawns: { sessionId: null, count: 0 },
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
}

function subagentSessionRoot(parentSessionFile: string | null): string {
  if (parentSessionFile) {
    const baseName = path.basename(parentSessionFile, ".jsonl");
    return path.join(path.dirname(parentSessionFile), baseName);
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "phenix-subagent-session-"));
}

function expandTilde(candidate: string): string {
  return candidate.startsWith("~/")
    ? path.join(os.homedir(), candidate.slice(2))
    : candidate;
}

function textFromResult(result: AgentToolResult<Details>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Temporarily set environment variables on process.env around an async
 * operation, then restore the original values. This is safe for serialized
 * foreground runs. Do not use with concurrent spawns.
 *
 * The spawned child process inherits process.env through
 * { ...process.env, ...sharedEnv } in pi-subagents' buildPiArgs/spawn.
 */
async function withChildEnvironment<T>(
  extraEnv: Readonly<Record<string, string>> | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!extraEnv || Object.keys(extraEnv).length === 0) {
    return operation();
  }

  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(extraEnv)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

export class SubagentBackend {
  private readonly events: EventBus;
  private readonly directExecutor: ReturnType<typeof createSubagentExecutor>;

  constructor(options: BackendOptions) {
    this.events = options.pi.events as unknown as EventBus;
    this.directExecutor = createSubagentExecutor({
      pi: options.pi,
      state: createState(),
      config: loadConfig(),
      asyncByDefault: false,
      tempArtifactsDir: getArtifactsDir(null),
      getSubagentSessionRoot: subagentSessionRoot,
      expandTilde,
      discoverAgents,
      allowMutatingManagementActions: false,
    });
  }

  async runForeground(
    runId: string,
    params: SubagentParamsLike,
    signal: AbortSignal,
    onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
    ctx: ExtensionContext,
    extraEnv?: Readonly<Record<string, string>>,
  ): Promise<AgentToolResult<Details>> {
    return withChildEnvironment(extraEnv, () =>
      this.directExecutor.execute(
        runId,
        { ...params, async: false, clarify: false },
        signal,
        onUpdate,
        ctx,
      ),
    );
  }

  async spawnBackground(
    requestId: string,
    params: SubagentParamsLike,
    signal: AbortSignal,
    extraEnv?: Readonly<Record<string, string>>,
  ): Promise<AsyncRunReference> {
    return withChildEnvironment(extraEnv, async () => {
    const response = await this.rpc("spawn", {
      ...params,
      async: true,
      clarify: false,
    }, signal, requestId);
    const data = response as {
      details?: { asyncId?: string; asyncDir?: string; runId?: string };
    };
    const runId = data.details?.asyncId ?? data.details?.runId;
    const asyncDir = data.details?.asyncDir;
    if (!runId || !asyncDir) {
      throw new Error("pi-subagents spawn did not return asyncId and asyncDir");
    }
    return { runId, asyncDir };
    });
  }

  async interrupt(runId: string, signal?: AbortSignal): Promise<void> {
    await this.rpc("interrupt", { id: runId }, signal);
  }

  async stop(runId: string, signal?: AbortSignal): Promise<void> {
    await this.rpc("stop", { id: runId }, signal);
  }

  resultPath(runId: string): string {
    return path.join(RESULTS_DIR, `${runId}.json`);
  }

  readResult(runId: string): AsyncResultPayload | undefined {
    const resultPath = this.resultPath(runId);
    try {
      return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async waitForResult(
    runId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<AsyncResultPayload> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (signal.aborted) throw new Error("subagent wait aborted");
      const result = this.readResult(runId);
      if (result) return result;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for subagent run ${runId}`);
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", abort);
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, 250);
        const abort = () => {
          clearTimeout(timer);
          cleanup();
          reject(new Error("subagent wait aborted"));
        };
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }

  foregroundChildren(result: AgentToolResult<Details>): RuntimeChildResult[] {
    const children = (result.details?.results ?? []) as RuntimeChildResult[];
    if (children.length > 0) {
      if (!result.isError) return children;
      return children.map((child, index) => index === children.length - 1
        ? {
            ...child,
            success: false,
            error: child.error ?? textFromResult(result) ?? "subagent execution failed",
          }
        : child);
    }
    return [{
      success: false,
      error: textFromResult(result) || "subagent execution returned no child result",
    }];
  }

  asyncResultChildren(payload: AsyncResultPayload): RuntimeChildResult[] {
    if (payload.results?.length) return [...payload.results];
    return [{
      success: payload.success,
      error: payload.error ?? `subagent run ended in state ${payload.state ?? "unknown"}`,
    }];
  }

  private async rpc(
    method: "spawn" | "interrupt" | "stop" | "status" | "ping",
    params: unknown,
    signal?: AbortSignal,
    explicitRequestId?: string,
  ): Promise<unknown> {
    const requestId = explicitRequestId ?? randomUUID();
    const replyEvent = subagentRpcReplyEvent(requestId);

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        if (typeof unsubscribe === "function") unsubscribe();
        signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
      };
      const finish = (reply: unknown) => {
        if (settled) return;
        cleanup();
        const envelope = reply as SubagentRpcReplyEnvelope;
        if (!envelope?.success) {
          reject(new Error(envelope?.error?.message ?? `subagent RPC ${method} failed`));
          return;
        }
        resolve(envelope.data);
      };
      const unsubscribe = this.events.on(replyEvent, finish);
      const abort = () => {
        if (settled) return;
        cleanup();
        reject(new Error(`subagent RPC ${method} aborted`));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`subagent RPC ${method} timed out`));
      }, 10_000);
      signal?.addEventListener("abort", abort, { once: true });

      this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId,
        method,
        params,
        source: { extension: "phenix-subagents" },
      });
    });
  }
}
