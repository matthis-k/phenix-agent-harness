import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

export interface RpcResponse {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type RpcEvent = Readonly<Record<string, unknown>>;

interface PendingCommand {
  readonly command: string;
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
  readonly detachAbort?: () => void;
}

export interface RpcJsonlPeerOptions {
  /** Allow the child-process close/error event to supply a richer failure than stdout EOF. */
  readonly endErrorDelayMs?: number;
}

export class RpcProtocolError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RpcProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponse(value: unknown): value is RpcResponse {
  return (
    isRecord(value) &&
    value.type === "response" &&
    typeof value.command === "string" &&
    typeof value.success === "boolean" &&
    (value.id === undefined || typeof value.id === "string")
  );
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error(reason ? String(reason) : "RPC command aborted.");
}

/** Strict LF-delimited JSON peer for Pi RPC mode. */
export class RpcJsonlPeer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly eventListeners = new Set<(event: RpcEvent) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private buffer = "";
  private terminalError: Error | undefined;
  private readonly endErrorDelayMs: number;
  private endErrorTimer: NodeJS.Timeout | undefined;

  constructor(input: Readable, output: Writable, options: RpcJsonlPeerOptions = {}) {
    this.input = input;
    this.output = output;
    this.endErrorDelayMs = options.endErrorDelayMs ?? 250;
    input.setEncoding("utf8");
    input.on("data", this.onData);
    input.once("end", this.onEnd);
    input.once("error", this.onInputError);
    output.once("error", this.onOutputError);
  }

  subscribe(listener: (event: RpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeErrors(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async command<TData = unknown>(
    command: Readonly<Record<string, unknown>> & { readonly type: string },
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<RpcResponse & { readonly data?: TData }> {
    if (this.terminalError) throw this.terminalError;
    if (options.signal?.aborted) throw abortError(options.signal);
    const id = typeof command.id === "string" ? command.id : `rpc_${randomUUID()}`;
    if (this.pending.has(id)) throw new RpcProtocolError(`Duplicate RPC command id: ${id}`);
    const timeoutMs = options.timeoutMs ?? 15_000;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.detachAbort?.();
        reject(
          new RpcProtocolError(`Pi RPC command ${command.type} timed out after ${timeoutMs}ms.`),
        );
      }, timeoutMs);
      timeout.unref?.();

      let detachAbort: (() => void) | undefined;
      if (options.signal) {
        const signal = options.signal;
        const onAbort = (): void => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timeout);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, {
        command: command.type,
        resolve,
        reject,
        timeout,
        ...(detachAbort ? { detachAbort } : {}),
      });
    });

    try {
      this.output.write(`${JSON.stringify({ ...command, id })}\n`, "utf8");
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.detachAbort?.();
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    const result = await response;
    if (!result.success) {
      throw new RpcProtocolError(
        `Pi RPC command ${result.command} failed${result.error ? `: ${result.error}` : "."}`,
      );
    }
    return result as RpcResponse & { readonly data?: TData };
  }

  notify(command: Readonly<Record<string, unknown>> & { readonly type: string }): void {
    if (this.terminalError) throw this.terminalError;
    this.output.write(`${JSON.stringify(command)}\n`, "utf8");
  }

  close(reason: Error = new RpcProtocolError("Pi RPC peer closed.")): void {
    this.clearEndErrorTimer();
    this.fail(reason);
  }

  dispose(): void {
    this.clearEndErrorTimer();
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("error", this.onInputError);
    this.output.off("error", this.onOutputError);
    this.fail(new RpcProtocolError("Pi RPC peer disposed."));
    this.eventListeners.clear();
    this.errorListeners.clear();
  }

  private readonly onData = (chunk: string | Buffer): void => {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (true) {
      const delimiter = this.buffer.indexOf("\n");
      if (delimiter < 0) return;
      let line = this.buffer.slice(0, delimiter);
      this.buffer = this.buffer.slice(delimiter + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      this.consumeLine(line);
      if (this.terminalError) return;
    }
  };

  private readonly onEnd = (): void => {
    const error =
      this.buffer.length > 0
        ? new RpcProtocolError("Pi RPC stream ended with an unterminated JSON record.")
        : new RpcProtocolError("Pi RPC stdout ended.");
    if (this.endErrorDelayMs <= 0) {
      this.fail(error);
      return;
    }
    this.clearEndErrorTimer();
    this.endErrorTimer = setTimeout(() => this.fail(error), this.endErrorDelayMs);
    this.endErrorTimer.unref?.();
  };

  private readonly onInputError = (error: Error): void => {
    this.fail(new RpcProtocolError(`Pi RPC stdout failed: ${error.message}`, { cause: error }));
  };

  private readonly onOutputError = (error: Error): void => {
    this.fail(new RpcProtocolError(`Pi RPC stdin failed: ${error.message}`, { cause: error }));
  };

  private consumeLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.fail(new RpcProtocolError("Pi RPC emitted malformed JSONL.", { cause: error }));
      return;
    }

    if (isResponse(value) && value.id) {
      const pending = this.pending.get(value.id);
      if (!pending) {
        this.fail(new RpcProtocolError(`Pi RPC returned an unknown response id: ${value.id}`));
        return;
      }
      if (pending.command !== value.command) {
        this.fail(
          new RpcProtocolError(
            `Pi RPC response command mismatch for ${value.id}: expected ${pending.command}, received ${value.command}.`,
          ),
        );
        return;
      }
      this.pending.delete(value.id);
      clearTimeout(pending.timeout);
      pending.detachAbort?.();
      pending.resolve(value);
      return;
    }

    if (isResponse(value)) {
      this.fail(
        new RpcProtocolError(`Pi RPC response for ${value.command} omitted its correlation id.`),
      );
      return;
    }

    if (!isRecord(value)) {
      this.fail(new RpcProtocolError("Pi RPC emitted a non-object event."));
      return;
    }
    for (const listener of this.eventListeners) listener(value);
  }

  private clearEndErrorTimer(): void {
    if (!this.endErrorTimer) return;
    clearTimeout(this.endErrorTimer);
    this.endErrorTimer = undefined;
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.clearEndErrorTimer();
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.detachAbort?.();
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.errorListeners) listener(error);
  }
}
