import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike } from "pi-subagents/src/runs/foreground/subagent-executor.ts";
import type { Details } from "pi-subagents/src/shared/types.ts";

import {
  SUBAGENT_RPC_PROTOCOL_VERSION,
  SUBAGENT_RPC_REQUEST_EVENT,
  subagentRpcReplyEvent,
  type SubagentRpcReplyEnvelope,
} from "pi-subagents/src/extension/rpc.ts";
import {
  RESULTS_DIR,
} from "pi-subagents/src/shared/types.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SpawnRequest {
  readonly requestId: string;
  readonly params: SubagentParamsLike;
  readonly environment: Readonly<Record<string, string>>;
  readonly extraAgentDirectory: string;
}

export interface SpawnedChild {
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

// ── Event bus interface ─────────────────────────────────────────────────────

interface EventBus {
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
  emit(event: string, payload: unknown): void;
}

// ── Async mutex ─────────────────────────────────────────────────────────────

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

// ── Spawn mutex singleton ───────────────────────────────────────────────────

const spawnMutex = new AsyncMutex();

// ── Environment snapshotting ────────────────────────────────────────────────

async function withTemporaryEnvironment<T>(
  env: Readonly<Record<string, string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  const extraAgentDirsKey = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

  // Snapshot every key being changed.
  for (const [name] of Object.entries(env)) {
    previous.set(name, process.env[name]);
  }
  // Also snapshot the extra agent dirs for merging.
  previous.set(extraAgentDirsKey, process.env[extraAgentDirsKey]);

  try {
    // Apply each environment variable.
    for (const [name, value] of Object.entries(env)) {
      process.env[name] = value;
    }

    return await fn();
  } finally {
    // Restore all changed keys.
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

// ── Text extraction ─────────────────────────────────────────────────────────

function textFromResult(result: AgentToolResult<Details>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

// ── Spawn backend ───────────────────────────────────────────────────────────

export class SubagentBackend {
  private readonly events: EventBus;

  constructor(pi: ExtensionAPI) {
    this.events = pi.events as unknown as EventBus;
  }

  // ── RPC helper ────────────────────────────────────────────────────────

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
      }, 20_000);
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

  // ── Unified spawn ─────────────────────────────────────────────────────

  /**
   * Spawn a child subagent through the pi-subagents RPC.
   *
   * Uses a global async mutex to serialize environment mutations during
   * the spawn window. The mutex is held only for the spawn RPC call,
   * not while waiting for child completion.
   *
   * Both foreground (await) and background (handle-return) modes
   * use the same spawn path.
   */
  async spawn(
    request: SpawnRequest,
    signal: AbortSignal,
  ): Promise<SpawnedChild> {
    const mergedAgentDirs = this.buildExtraAgentDirs(
      request.extraAgentDirectory,
    );

    const env: Record<string, string> = {
      ...request.environment,
      PI_SUBAGENT_EXTRA_AGENT_DIRS: mergedAgentDirs,
    };

    return spawnMutex.runExclusive(async () => {
      return withTemporaryEnvironment(env, async () => {
        const response = await this.rpc("spawn", {
          ...request.params,
          async: true,
          clarify: false,
        }, signal, request.requestId);

        const data = response as {
          details?: { asyncId?: string; asyncDir?: string; runId?: string };
        };
        const runId = data.details?.asyncId ?? data.details?.runId;
        const asyncDir = data.details?.asyncDir;
        if (!runId || !asyncDir) {
          throw new Error(
            "pi-subagents spawn did not return asyncId and asyncDir",
          );
        }
        return { runId, asyncDir };
      });
    });
  }

  // ── Wait for result ───────────────────────────────────────────────────

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
        const abort = () => {
          signal.removeEventListener("abort", abort);
          clearTimeout(timer);
          reject(new Error("subagent wait aborted"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 250);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }

  // ── Interrupt / stop ──────────────────────────────────────────────────

  async interrupt(runId: string, signal?: AbortSignal): Promise<void> {
    await this.rpc("interrupt", { id: runId }, signal);
  }

  async stop(runId: string, signal?: AbortSignal): Promise<void> {
    await this.rpc("stop", { id: runId }, signal);
  }

  // ── Result reading ────────────────────────────────────────────────────

  resultPath(runId: string): string {
    return path.join(RESULTS_DIR, `${runId}.json`);
  }

  readResult(runId: string): AsyncResultPayload | undefined {
    const resultPath = this.resultPath(runId);
    try {
      return JSON.parse(
        fs.readFileSync(resultPath, "utf-8"),
      ) as AsyncResultPayload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  // ── Child result helpers ──────────────────────────────────────────────

  foregroundChildren(
    result: AgentToolResult<Details>,
  ): RuntimeChildResult[] {
    const children = (result.details?.results ?? []) as RuntimeChildResult[];
    if (children.length > 0) {
      if (!result.isError) return children;
      return children.map((child, index) =>
        index === children.length - 1
          ? {
              ...child,
              success: false,
              error:
                child.error ??
                textFromResult(result) ??
                "subagent execution failed",
            }
          : child,
      );
    }
    return [
      {
        success: false,
        error:
          textFromResult(result) ||
          "subagent execution returned no child result",
      },
    ];
  }

  asyncResultChildren(payload: AsyncResultPayload): RuntimeChildResult[] {
    if (payload.results?.length) return [...payload.results];
    return [
      {
        success: payload.success,
        error:
          payload.error ??
          `subagent run ended in state ${payload.state ?? "unknown"}`,
      },
    ];
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private buildExtraAgentDirs(
    contractAgentDir: string,
  ): string {
    const current = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS
      ?.split(path.delimiter)
      .filter(Boolean) ?? [];

    const merged = [
      ...current.filter(
        (entry) => path.resolve(entry) !== path.resolve(contractAgentDir),
      ),
      contractAgentDir,
    ];

    return merged.join(path.delimiter);
  }
}
