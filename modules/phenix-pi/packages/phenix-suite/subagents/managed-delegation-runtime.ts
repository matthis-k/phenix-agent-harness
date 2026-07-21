/**
 * managed-delegation-runtime — workflow handle execution and lifecycle
 *
 * Workflow code supplies an authoritative compiler and persisted handle record.
 * This service owns deadlines, foreground/background settlement, polling,
 * awaiting, cancellation, and orphan detection through the manager directory.
 */

import { finalizeHandleWorkflow } from "@matthis-k/phenix-flow/workflow-runtime.ts";
import { ChildRuntimeError } from "../runtime/child-session-types.ts";
import type { SubagentExecutionCompiler } from "../runtime/execution-plan.ts";
import type { SubagentRequest } from "../runtime/subagent-api.ts";
import {
  type SubagentCancellation,
  SubagentExecutionError,
  type SubagentHandle,
} from "../runtime/subagent-manager.ts";
import type { SubagentManagerFactory } from "../runtime/subagent-manager-factory.ts";
import {
  type ManagedBackgroundSettlement,
  publishManagedBackgroundSettlement,
} from "./background-settlement-channel.ts";
import { readRecord, writeRecord } from "./handle-store.ts";
import type { HandleRecord } from "./handle-types.ts";
import { isTerminalHandleStatus } from "./handle-types.ts";

export interface ManagedDelegationFailure {
  readonly code: string;
  readonly message: string;
}

export type ManagedDelegationExecutionResult =
  | { readonly ok: true; readonly record: HandleRecord }
  | {
      readonly ok: false;
      readonly record: HandleRecord;
      readonly error: ManagedDelegationFailure;
    };

interface ManagedCompletion {
  readonly record: HandleRecord;
  readonly error?: ManagedDelegationFailure;
}

export interface ManagedDelegationExecutionInput {
  readonly compiler: SubagentExecutionCompiler;
  readonly request: SubagentRequest<unknown>;
  readonly record: HandleRecord;
  readonly cwd: string;
  readonly sessionId: string;
  readonly mode: "await" | "background";
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly rootSubagentId: string;
  readonly settle: (record: HandleRecord) => void;
}

export interface ManagedHandleLookup {
  readonly cwd: string;
  readonly sessionId: string;
  readonly id: string;
}

function executionFailure(error: unknown): ManagedDelegationFailure {
  if (error instanceof SubagentExecutionError || error instanceof ChildRuntimeError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "SUBAGENT_EXECUTION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function cancellationFromSignal(signal: AbortSignal, fallback: string): SubagentCancellation {
  const reason = signal.reason;
  if (reason instanceof SubagentExecutionError || reason instanceof ChildRuntimeError) {
    return { code: reason.code, reason: reason.message };
  }
  return {
    code: "ABORTED",
    reason:
      reason instanceof Error
        ? reason.message
        : typeof reason === "string" && reason.length > 0
          ? reason
          : fallback,
  };
}

function terminalStatus(code: string): "cancelled" | "failed" {
  return code === "ABORTED" ? "cancelled" : "failed";
}

export interface ManagedDelegationRuntimeOptions {
  readonly managers: SubagentManagerFactory;
}

export class ManagedDelegationRuntime {
  private readonly managers: SubagentManagerFactory;

  constructor(options: ManagedDelegationRuntimeOptions) {
    this.managers = options.managers;
  }

  get activeCount(): number {
    return this.managers.activeCount;
  }

  shutdown(reason: string): Promise<void> {
    return this.managers.shutdown(reason);
  }

  async execute(input: ManagedDelegationExecutionInput): Promise<ManagedDelegationExecutionResult> {
    const controller = new AbortController();
    const followsParent = input.mode === "await";
    const abortFromParent = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(
          input.signal.reason ??
            new ChildRuntimeError("ABORTED", "Delegated execution was cancelled by its parent."),
        );
      }
    };

    if (followsParent) {
      if (input.signal.aborted) abortFromParent();
      else input.signal.addEventListener("abort", abortFromParent, { once: true });
    }

    let timeout: NodeJS.Timeout | undefined;
    if (input.timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(
            new ChildRuntimeError(
              "TIMEOUT",
              `Delegated execution timed out after ${input.timeoutMs}ms.`,
            ),
          );
        }
      }, input.timeoutMs);
      timeout.unref?.();
    }

    const cleanup = (): void => {
      if (followsParent) input.signal.removeEventListener("abort", abortFromParent);
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };

    let handle: SubagentHandle<unknown>;
    try {
      handle = await this.managers.create(input.compiler).spawn(input.request, controller.signal);
    } catch (error) {
      cleanup();
      const failure = executionFailure(error);
      input.record.status = terminalStatus(failure.code);
      input.record.errors = [`${failure.code}: ${failure.message}`];
      writeRecord(input.cwd, input.record);
      input.settle(input.record);
      return { ok: false, record: input.record, error: failure };
    }

    const cancelFromScope = (): void => {
      void handle.cancel(
        cancellationFromSignal(controller.signal, "Delegated execution was cancelled."),
      );
    };
    if (controller.signal.aborted) cancelFromScope();
    else controller.signal.addEventListener("abort", cancelFromScope, { once: true });

    const cleanupHandle = (): void => {
      controller.signal.removeEventListener("abort", cancelFromScope);
      cleanup();
    };

    input.record.subagentId = handle.id;
    input.record.rootSubagentId = input.rootSubagentId;
    input.record.status = "running";
    writeRecord(input.cwd, input.record);

    const completion: Promise<ManagedCompletion> = handle.result().then(
      () => ({ record: readRecord(input.cwd, input.sessionId, input.record.id) ?? input.record }),
      (error) => {
        const failure = executionFailure(error);
        const record = readRecord(input.cwd, input.sessionId, input.record.id) ?? input.record;
        if (!isTerminalHandleStatus(record.status)) {
          record.status = terminalStatus(failure.code);
          record.errors = [`${failure.code}: ${failure.message}`];
          writeRecord(input.cwd, record);
        }
        return { record, error: failure };
      },
    );

    if (input.mode === "background") {
      void completion
        .then(async ({ record }) => {
          input.settle(record);
          await publishManagedBackgroundSettlement({
            cwd: input.cwd,
            sessionId: input.sessionId,
            record,
          } satisfies ManagedBackgroundSettlement);
        })
        .finally(() => {
          cleanupHandle();
          this.managers.remove(handle.id);
        })
        .catch(() => undefined);
      return { ok: true, record: input.record };
    }

    try {
      const settled = await completion;
      input.settle(settled.record);
      if (settled.record.status === "completed") {
        return { ok: true, record: settled.record };
      }
      return {
        ok: false,
        record: settled.record,
        error: settled.error ?? {
          code: "CHILD_EXECUTION_FAILED",
          message: "Delegated child execution failed.",
        },
      };
    } finally {
      cleanupHandle();
      this.managers.remove(handle.id);
    }
  }

  poll(input: ManagedHandleLookup): HandleRecord | undefined {
    const record = readRecord(input.cwd, input.sessionId, input.id);
    if (!record || isTerminalHandleStatus(record.status)) return record;
    if (!record.subagentId) return record;
    return this.managers.get(record.subagentId) ? record : this.orphan(input.cwd, record);
  }

  async awaitHandle(
    input: ManagedHandleLookup,
    signal: AbortSignal,
  ): Promise<HandleRecord | undefined> {
    const record = readRecord(input.cwd, input.sessionId, input.id);
    if (!record || isTerminalHandleStatus(record.status)) return record;
    if (!record.subagentId) return record;

    const handle = this.managers.get(record.subagentId);
    if (!handle) return this.orphan(input.cwd, record);

    try {
      await handle.result(signal);
    } catch (error) {
      if (signal.aborted) throw error;

      const failure = executionFailure(error);
      const current = readRecord(input.cwd, input.sessionId, input.id) ?? record;
      if (!isTerminalHandleStatus(current.status)) {
        current.status = terminalStatus(failure.code);
        current.errors = [`${failure.code}: ${failure.message}`];
        writeRecord(input.cwd, current);
      }
      return current;
    }

    return readRecord(input.cwd, input.sessionId, input.id) ?? record;
  }

  async sendHandle(
    input: ManagedHandleLookup,
    message: string,
    signal: AbortSignal,
  ): Promise<HandleRecord | undefined> {
    const record = readRecord(input.cwd, input.sessionId, input.id);
    if (!record) return undefined;
    if (isTerminalHandleStatus(record.status)) {
      throw new SubagentExecutionError(
        "SUBAGENT_NOT_RUNNING",
        `Cannot send to terminal Phenix handle ${record.id} (${record.status}).`,
      );
    }
    if (!record.subagentId) {
      throw new SubagentExecutionError(
        "SUBAGENT_NOT_READY",
        `Phenix handle ${record.id} has not attached a live child session yet.`,
      );
    }

    const handle = this.managers.get(record.subagentId);
    if (!handle) {
      const orphaned = this.orphan(input.cwd, record);
      throw new SubagentExecutionError(
        "ORPHANED_SESSION",
        orphaned.errors?.at(-1) ?? `No live managed subagent exists for handle ${record.id}.`,
      );
    }

    await handle.send(message, signal);
    return readRecord(input.cwd, input.sessionId, input.id) ?? record;
  }

  async cancelHandle(
    input: ManagedHandleLookup,
    reason: string,
  ): Promise<HandleRecord | undefined> {
    const record = readRecord(input.cwd, input.sessionId, input.id);
    if (!record || isTerminalHandleStatus(record.status)) return record;

    record.status = "cancelled";
    record.errors = [...(record.errors ?? []), reason];
    writeRecord(input.cwd, record);

    if (record.subagentId) {
      const handle = this.managers.get(record.subagentId);
      if (handle) {
        try {
          await handle.cancel(reason);
        } finally {
          this.managers.remove(record.subagentId);
        }
      }
    }

    this.finalize(input.cwd, record);
    return record;
  }

  private orphan(cwd: string, record: HandleRecord): HandleRecord {
    if (!isTerminalHandleStatus(record.status)) {
      record.status = "orphaned";
      record.errors = [
        ...(record.errors ?? []),
        "ORPHANED_SESSION: no live managed subagent exists for this persisted handle.",
      ];
      writeRecord(cwd, record);
      this.finalize(cwd, record);
    }
    return record;
  }

  private finalize(cwd: string, record: HandleRecord): void {
    if (!record.workflowBinding) return;
    try {
      const finalized = finalizeHandleWorkflow({ cwd, handle: record });
      if (!finalized) {
        throw new Error(
          `Workflow finalization returned no record for terminal handle ${record.id}.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = `WORKFLOW_FINALIZATION_FAILED: ${message}`;
      if (!record.errors?.includes(diagnostic)) {
        record.errors = [...(record.errors ?? []), diagnostic];
        writeRecord(cwd, record);
      }
    }
  }
}

export function createManagedDelegationRuntime(
  options: ManagedDelegationRuntimeOptions,
): ManagedDelegationRuntime {
  return new ManagedDelegationRuntime(options);
}
