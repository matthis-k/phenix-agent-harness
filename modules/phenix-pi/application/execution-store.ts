import { AttentionProjection } from "../domain/attention/projection.ts";
import type {
  DomainEvent,
  DomainEventType,
  PendingDomainEvent,
  UnsequencedDomainEvent,
} from "../domain/run/events.ts";
import { RunProjection } from "../domain/run/reducer.ts";
import type { RunId } from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { RunLedger } from "../ports/run-ledger.ts";
import type { OrderedDomainEventBus } from "./domain-event-bus.ts";
import { KeyedSerialExecutor } from "./keyed-serial-executor.ts";

export class ExecutionStore {
  readonly projection = new RunProjection();
  readonly attention = new AttentionProjection();
  readonly events: OrderedDomainEventBus;
  private readonly ledger: RunLedger;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly loadedRoots = new Set<RunId>();
  private readonly executor = new KeyedSerialExecutor<RunId>();

  constructor(input: {
    readonly ledger: RunLedger;
    readonly events: OrderedDomainEventBus;
    readonly clock: Clock;
    readonly ids: IdGenerator;
  }) {
    this.ledger = input.ledger;
    this.events = input.events;
    this.clock = input.clock;
    this.ids = input.ids;
  }

  async load(rootRunId: RunId): Promise<readonly DomainEvent[]> {
    return this.executor.run(rootRunId, async () => {
      if (this.loadedRoots.has(rootRunId)) {
        return this.projection.events.filter((event) => event.rootRunId === rootRunId);
      }
      const events = [...(await this.ledger.load(rootRunId))].sort(
        (left, right) => left.sequence - right.sequence,
      );
      for (const event of events) this.apply(event);
      this.loadedRoots.add(rootRunId);
      return events;
    });
  }

  async commit<TType extends DomainEventType>(
    rootRunId: RunId,
    pending: readonly PendingDomainEvent<TType>[],
  ): Promise<readonly DomainEvent[]> {
    return this.executor.run(rootRunId, async () => {
      if (!this.loadedRoots.has(rootRunId)) await this.loadUnlocked(rootRunId);
      const revisions = new Map<RunId, number>();
      const unsequenced: UnsequencedDomainEvent<TType>[] = [];
      const pendingIds = new Set<string>();

      for (const candidate of pending) {
        const eventId = candidate.eventId ?? this.ids.next("event");
        if (this.projection.eventIds.has(eventId) || pendingIds.has(eventId)) continue;
        pendingIds.add(eventId);
        const currentRevision =
          revisions.get(candidate.runId) ??
          this.projection.runs.get(candidate.runId)?.revision ??
          0;
        const revision = currentRevision + 1;
        revisions.set(candidate.runId, revision);
        const existing = this.projection.runs.get(candidate.runId);
        const parentRunId = candidate.parentRunId ?? existing?.parentId;
        unsequenced.push({
          ...candidate,
          eventId,
          rootRunId,
          ...(parentRunId ? { parentRunId } : {}),
          revision,
          timestamp: this.clock.now(),
        });
      }

      if (unsequenced.length === 0) return [];
      const correlated = widenUnsequencedEvents(unsequenced);
      const expected = this.projection.rootSequences.get(rootRunId) ?? 0;
      const staged: DomainEvent[] = correlated.map((event, index) => ({
        ...event,
        sequence: expected + index + 1,
      }));
      this.projection.assertApplicable(staged);
      this.attention.assertApplicable(staged);
      const events = await this.ledger.append(rootRunId, expected, correlated);
      for (const event of events) this.apply(event);
      this.events.publish(events);
      return events;
    });
  }

  sequence(rootRunId: RunId): number {
    return this.projection.rootSequences.get(rootRunId) ?? 0;
  }

  private async loadUnlocked(rootRunId: RunId): Promise<void> {
    const events = [...(await this.ledger.load(rootRunId))].sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const event of events) this.apply(event);
    this.loadedRoots.add(rootRunId);
  }

  private apply(event: DomainEvent): void {
    this.projection.apply(event);
    this.attention.apply(event);
  }
}

function widenUnsequencedEvents<TType extends DomainEventType>(
  events: readonly UnsequencedDomainEvent<TType>[],
): readonly UnsequencedDomainEvent[] {
  return events as unknown as readonly UnsequencedDomainEvent[];
}
