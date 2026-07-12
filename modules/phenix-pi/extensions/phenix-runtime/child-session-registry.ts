/**
 * child-session-registry — live child run registry
 *
 * Replaces result-file polling and accidental attempt restarts with
 * a live-run registry. Background delegation registers a live completion
 * promise; poll/await/cancel operate on the same registered run.
 */

import type {
  ChildRun,
  ChildRunId,
} from "./child-session-types.ts";

// ── Attempt run result (forward declaration) ────────────────────────────────

export interface AttemptRunResult {
  readonly ok: boolean;
  readonly status: "completed" | "failed" | "cancelled";
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly record?: unknown;
}

// ── Live child run record ───────────────────────────────────────────────────

export interface LiveChildRunRecord {
  readonly run: ChildRun;
  readonly completion: Promise<AttemptRunResult>;
  readonly controller: AbortController;
}

// ── Registry ────────────────────────────────────────────────────────────────

export class ChildSessionRegistry {
  private readonly runs = new Map<ChildRunId, LiveChildRunRecord>();

  add(record: LiveChildRunRecord): void {
    this.runs.set(record.run.id, record);
  }

  get(id: ChildRunId): LiveChildRunRecord | undefined {
    return this.runs.get(id);
  }

  remove(id: ChildRunId): void {
    this.runs.delete(id);
  }

  list(): readonly LiveChildRunRecord[] {
    return [...this.runs.values()];
  }

  /**
   * Shutdown all active runs.
   *
   * 1. Stop accepting new delegation (caller's responsibility).
   * 2. Abort all active child runs.
   * 3. Await bounded cleanup.
   * 4. Unsubscribe event listeners (done by each run's dispose).
   * 5. Dispose SDK sessions / stop RPC clients (done by each run's dispose).
   */
  async shutdown(reason: string): Promise<void> {
    const active = this.list();
    this.runs.clear();

    await Promise.allSettled(
      active.map(async (record) => {
        try {
          record.controller.abort();
        } catch {
          // Abort may throw if already aborted — ignore.
        }
        try {
          await record.run.abort(reason);
        } catch {
          // Best-effort abort.
        }
        try {
          await record.run.dispose();
        } catch {
          // Best-effort dispose.
        }
      }),
    );
  }
}

// ── Singleton registry ──────────────────────────────────────────────────────

let _registry: ChildSessionRegistry | undefined;

export function getChildSessionRegistry(): ChildSessionRegistry {
  if (!_registry) {
    _registry = new ChildSessionRegistry();
  }
  return _registry;
}

export function resetChildSessionRegistry(): void {
  _registry = undefined;
}
