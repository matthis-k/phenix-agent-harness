import type { DomainEvent, UnsequencedDomainEvent } from "../domain/run/events.ts";
import type { RunId } from "../domain/shared.ts";

export class LedgerConflictError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`Ledger sequence conflict: expected ${expected}, actual ${actual}`);
    this.name = "LedgerConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

export interface RunLedger {
  load(rootRunId: RunId): Promise<readonly DomainEvent[]>;
  append(
    rootRunId: RunId,
    expectedSequence: number,
    events: readonly UnsequencedDomainEvent[],
  ): Promise<readonly DomainEvent[]>;
}
