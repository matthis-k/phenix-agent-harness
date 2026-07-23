import type { DomainEvent, UnsequencedDomainEvent } from "../../domain/run/events.ts";
import type { RunId } from "../../domain/shared.ts";
import { LedgerConflictError, type RunLedger } from "../../ports/run-ledger.ts";

export class InMemoryRunLedger implements RunLedger {
  private readonly streams = new Map<RunId, DomainEvent[]>();

  async load(rootRunId: RunId): Promise<readonly DomainEvent[]> {
    return [...(this.streams.get(rootRunId) ?? [])];
  }

  async append(
    rootRunId: RunId,
    expectedSequence: number,
    events: readonly UnsequencedDomainEvent[],
  ): Promise<readonly DomainEvent[]> {
    const stream = this.streams.get(rootRunId) ?? [];
    if (stream.length !== expectedSequence) {
      throw new LedgerConflictError(expectedSequence, stream.length);
    }
    const committed = events.map((event, index) => ({
      ...event,
      sequence: expectedSequence + index + 1,
    }));
    stream.push(...committed);
    this.streams.set(rootRunId, stream);
    return committed;
  }
}
