/**
 * child-session-registry — live managed subagent registry
 *
 * Background delegation registers the public SubagentHandle produced by the
 * production manager. Poll, await, cancel, and shutdown therefore use the same
 * lifecycle surface as direct callers instead of reaching into backend runs.
 */

import type { SubagentHandle } from "./subagent-manager.ts";

export interface LiveChildRunRecord {
  readonly handle: SubagentHandle<unknown>;
  readonly completion: Promise<unknown>;
}

export class ChildSessionRegistry {
  private readonly runs = new Map<string, LiveChildRunRecord>();

  add(record: LiveChildRunRecord): void {
    this.runs.set(record.handle.id, record);
  }

  get(id: string): LiveChildRunRecord | undefined {
    return this.runs.get(id);
  }

  remove(id: string): void {
    this.runs.delete(id);
  }

  list(): readonly LiveChildRunRecord[] {
    return [...this.runs.values()];
  }

  async shutdown(reason: string): Promise<void> {
    const active = this.list();
    this.runs.clear();
    await Promise.allSettled(active.map((record) => record.handle.cancel(reason)));
  }
}

let registry: ChildSessionRegistry | undefined;

export function getChildSessionRegistry(): ChildSessionRegistry {
  registry ??= new ChildSessionRegistry();
  return registry;
}

export function resetChildSessionRegistry(): void {
  registry = undefined;
}
