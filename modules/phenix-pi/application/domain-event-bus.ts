import type { DomainEvent } from "../domain/run/events.ts";

export type DomainEventListener = (event: DomainEvent) => void | Promise<void>;

interface Subscription {
  readonly listener: DomainEventListener;
  active: boolean;
  tail: Promise<void>;
}

export class OrderedDomainEventBus {
  private readonly subscriptions = new Set<Subscription>();

  subscribe(listener: DomainEventListener): () => void {
    const subscription: Subscription = {
      listener,
      active: true,
      tail: Promise.resolve(),
    };
    this.subscriptions.add(subscription);
    return () => {
      subscription.active = false;
      this.subscriptions.delete(subscription);
    };
  }

  publish(events: readonly DomainEvent[]): void {
    for (const subscription of this.subscriptions) {
      for (const event of events) {
        subscription.tail = subscription.tail
          .then(async () => {
            if (subscription.active) await subscription.listener(event);
          })
          .catch((error: unknown) => {
            console.error(
              `[phenix] domain event subscriber failed for ${event.type}:`,
              error instanceof Error ? error.message : String(error),
            );
          });
      }
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.subscriptions].map((subscription) => subscription.tail));
  }
}
