import type { DomainEvent } from "../domain/run/events.ts";

export type DomainEventListener = (event: DomainEvent) => void | Promise<void>;

export interface DomainEventSubscriberError {
  readonly event: DomainEvent;
  readonly error: unknown;
}

interface Subscription {
  readonly listener: DomainEventListener;
  active: boolean;
  tail: Promise<void>;
}

export class OrderedDomainEventBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly onSubscriberError: (failure: DomainEventSubscriberError) => void | Promise<void>;

  constructor(
    input: {
      readonly onSubscriberError?: (failure: DomainEventSubscriberError) => void | Promise<void>;
    } = {},
  ) {
    this.onSubscriberError = input.onSubscriberError ?? (() => undefined);
  }

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
          .catch(async (error: unknown) => {
            try {
              await this.onSubscriberError({ event, error });
            } catch {
              // Subscriber error reporting must not break ordered delivery.
            }
          });
      }
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.subscriptions].map((subscription) => subscription.tail));
  }
}
