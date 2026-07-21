/** Process-local publication boundary for terminal background delegation results. */

import type { HandleRecord } from "./handle-types.ts";

export interface ManagedBackgroundSettlement {
  readonly cwd: string;
  readonly sessionId: string;
  readonly record: HandleRecord;
}

export type ManagedBackgroundSettlementListener = (
  settlement: ManagedBackgroundSettlement,
) => void | Promise<void>;

const listeners = new Set<ManagedBackgroundSettlementListener>();

export function subscribeManagedBackgroundSettlements(
  listener: ManagedBackgroundSettlementListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function publishManagedBackgroundSettlement(
  settlement: ManagedBackgroundSettlement,
): Promise<void> {
  await Promise.allSettled([...listeners].map((listener) => listener(settlement)));
}
