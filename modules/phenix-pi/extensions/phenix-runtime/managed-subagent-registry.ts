/**
 * managed-subagent-registry — live public subagent handles
 *
 * The registry stores only the stable SubagentHandle surface. Backend sessions,
 * Pi identifiers, and workflow records remain outside this runtime primitive.
 */

import type { SubagentHandle } from "./subagent-manager.ts";

export class ManagedSubagentRegistry {
  private readonly handles = new Map<string, SubagentHandle<unknown>>();

  add(handle: SubagentHandle<unknown>): void {
    this.handles.set(handle.id, handle);
  }

  get(id: string): SubagentHandle<unknown> | undefined {
    return this.handles.get(id);
  }

  remove(id: string): void {
    this.handles.delete(id);
  }

  list(): readonly SubagentHandle<unknown>[] {
    return [...this.handles.values()];
  }

  get size(): number {
    return this.handles.size;
  }

  async shutdown(reason: string): Promise<void> {
    const active = this.list();
    this.handles.clear();
    await Promise.allSettled(active.map((handle) => handle.cancel(reason)));
  }
}

export function createManagedSubagentRegistry(): ManagedSubagentRegistry {
  return new ManagedSubagentRegistry();
}
