/**
 * subagent-manager — application facade for Phenix subagents
 *
 * Callers use `run()` for an awaited typed result or `spawn()` for explicit
 * asynchronous lifecycle management. The manager depends on one execution
 * adapter port; workflow-aware and standalone implementations may compile the
 * same public request into different policies without changing this API.
 */

import type { ThinkingLevel } from "../phenix-kernel/task.ts";
import type { ConcreteModelRef } from "./child-session-types.ts";
import type { SubagentRequest } from "./subagent-api.ts";

export type SubagentStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

export interface SubagentSnapshot {
  readonly id: string;
  readonly status: SubagentStatus;
  readonly parentId?: string;
  readonly model?: ConcreteModelRef;
  readonly thinking?: ThinkingLevel;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface SubagentEvent {
  readonly type: string;
  readonly snapshot: SubagentSnapshot;
  readonly data?: unknown;
}

/**
 * Persistent asynchronous control surface for one subagent.
 *
 * Cancelling a `result()` wait must not implicitly cancel the child. Explicit
 * child termination is always performed through `cancel()`.
 */
export interface SubagentHandle<TOutput> {
  readonly id: string;

  snapshot(): SubagentSnapshot;
  poll(): Promise<SubagentSnapshot>;
  result(signal?: AbortSignal): Promise<TOutput>;

  send(message: string, signal?: AbortSignal): Promise<void>;
  cancel(reason?: string): Promise<void>;

  subscribe(listener: (event: SubagentEvent) => void): () => void;
}

/**
 * Anti-corruption port between the stable public API and an execution system.
 *
 * An adapter owns request compilation, contracts, verification, persistence,
 * and the concrete Pi/session backend. The manager owns only API semantics.
 */
export interface SubagentExecutionAdapter {
  spawn<TOutput>(
    request: SubagentRequest<TOutput>,
    signal?: AbortSignal,
  ): Promise<SubagentHandle<TOutput>>;
}

export class SubagentExecutionError extends Error {
  readonly code: string;
  readonly snapshot: SubagentSnapshot | undefined;

  constructor(
    code: string,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly snapshot?: SubagentSnapshot;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SubagentExecutionError";
    this.code = code;
    this.snapshot = options.snapshot;
  }
}

function validateRequest(request: SubagentRequest<unknown>): void {
  if (request.task.trim().length === 0) {
    throw new TypeError("Subagent task must be non-empty.");
  }

  if (
    typeof request.returns.schema !== "object" ||
    request.returns.schema === null ||
    Array.isArray(request.returns.schema)
  ) {
    throw new TypeError("Subagent return schema must be a JSON Schema object.");
  }

  for (const requirement of request.requirements ?? []) {
    if (requirement.trim().length === 0) {
      throw new TypeError("Subagent requirements must be non-empty strings.");
    }
  }
}

export class SubagentManager {
  private readonly adapter: SubagentExecutionAdapter;

  constructor(adapter: SubagentExecutionAdapter) {
    this.adapter = adapter;
  }

  /** Spawn a child and return immediately after its execution handle is ready. */
  async spawn<TOutput>(
    request: SubagentRequest<TOutput>,
    signal?: AbortSignal,
  ): Promise<SubagentHandle<TOutput>> {
    validateRequest(request);
    return this.adapter.spawn(request, signal);
  }

  /** Spawn a child and await its accepted, decoded structured result. */
  async run<TOutput>(
    request: SubagentRequest<TOutput>,
    signal?: AbortSignal,
  ): Promise<TOutput> {
    const handle = await this.spawn(request, signal);
    return handle.result(signal);
  }
}

export function createSubagentManager(adapter: SubagentExecutionAdapter): SubagentManager {
  return new SubagentManager(adapter);
}
