import type { DomainEvent } from "../run/events.ts";
import type { RunId } from "../shared.ts";
import type {
  AttentionDeliveredData,
  AttentionDeliveryDeferredData,
  AttentionDeliveryFailedData,
  AttentionEnvelope,
  AttentionId,
  AttentionRoutedData,
  AttentionRoutingFailedData,
  AttentionTarget,
} from "./model.ts";

export type AttentionDeliveryState =
  | {
      readonly status: "deferred";
      readonly target: AttentionTarget;
      readonly reason: string;
    }
  | {
      readonly status: "delivered";
      readonly target: AttentionTarget;
      readonly deferred: boolean;
    }
  | {
      readonly status: "failed";
      readonly target: AttentionTarget;
      readonly reason: string;
    };

export interface AttentionRecord {
  readonly envelope: AttentionEnvelope;
  readonly route?: AttentionRoutedData;
  readonly routingFailure?: AttentionRoutingFailedData;
  readonly deliveries: ReadonlyMap<RunId, AttentionDeliveryState>;
}

export interface PendingAttentionDelivery {
  readonly attentionId: AttentionId;
  readonly rootRunId: RunId;
  readonly message: string;
  readonly target: AttentionTarget;
}

export class AttentionProjection {
  readonly records = new Map<AttentionId, AttentionRecord>();

  apply(event: DomainEvent): void {
    switch (event.type) {
      case "attention.received":
        this.applyReceived(event);
        return;
      case "attention.routed":
        this.applyRouted(event);
        return;
      case "attention.routing.failed":
        this.applyRoutingFailed(event);
        return;
      case "attention.delivery.deferred":
        this.applyDeferred(event);
        return;
      case "attention.delivered":
        this.applyDelivered(event);
        return;
      case "attention.delivery.failed":
        this.applyDeliveryFailed(event);
        return;
      default:
        return;
    }
  }

  assertApplicable(events: readonly DomainEvent[]): void {
    const staged = this.fork();
    for (const event of events) staged.apply(event);
  }

  pendingDeliveries(rootRunId: RunId): readonly PendingAttentionDelivery[] {
    const pending: PendingAttentionDelivery[] = [];
    for (const [attentionId, record] of this.records) {
      if (record.envelope.rootRunId !== rootRunId) continue;
      for (const state of record.deliveries.values()) {
        if (state.status !== "deferred") continue;
        pending.push({
          attentionId,
          rootRunId,
          message: record.envelope.message,
          target: state.target,
        });
      }
    }
    return pending;
  }

  private applyReceived(event: DomainEvent): void {
    const envelope = (event.data as { readonly envelope: AttentionEnvelope }).envelope;
    if (event.runId !== event.rootRunId || envelope.rootRunId !== event.rootRunId) {
      throw new Error(`Attention ${envelope.id} must be recorded on its root run`);
    }
    if (this.records.has(envelope.id)) {
      throw new Error(`Attention already exists: ${envelope.id}`);
    }
    this.records.set(envelope.id, { envelope, deliveries: new Map() });
  }

  private applyRouted(event: DomainEvent): void {
    const data = event.data as AttentionRoutedData;
    const record = this.require(data.attentionId, event.rootRunId);
    if (record.route || record.routingFailure) {
      throw new Error(`Attention ${data.attentionId} already has a routing outcome`);
    }
    const targets = new Set<RunId>();
    for (const target of data.targets) {
      if (targets.has(target.runId)) {
        throw new Error(`Attention ${data.attentionId} routes to ${target.runId} more than once`);
      }
      targets.add(target.runId);
    }
    this.records.set(data.attentionId, { ...record, route: data });
  }

  private applyRoutingFailed(event: DomainEvent): void {
    const data = event.data as AttentionRoutingFailedData;
    const record = this.require(data.attentionId, event.rootRunId);
    if (record.route || record.routingFailure) {
      throw new Error(`Attention ${data.attentionId} already has a routing outcome`);
    }
    this.records.set(data.attentionId, { ...record, routingFailure: data });
  }

  private applyDeferred(event: DomainEvent): void {
    const data = event.data as AttentionDeliveryDeferredData;
    const record = this.requireRoutedTarget(data.attentionId, event.rootRunId, data.target);
    this.assertDeliveryOpen(data.attentionId, record, data.target.runId);
    const deliveries = new Map(record.deliveries);
    deliveries.set(data.target.runId, {
      status: "deferred",
      target: data.target,
      reason: data.reason,
    });
    this.records.set(data.attentionId, { ...record, deliveries });
  }

  private applyDelivered(event: DomainEvent): void {
    const data = event.data as AttentionDeliveredData;
    const record = this.requireRoutedTarget(data.attentionId, event.rootRunId, data.target);
    this.assertDeliveryOpen(data.attentionId, record, data.target.runId);
    const deliveries = new Map(record.deliveries);
    deliveries.set(data.target.runId, {
      status: "delivered",
      target: data.target,
      deferred: data.deferred,
    });
    this.records.set(data.attentionId, { ...record, deliveries });
  }

  private applyDeliveryFailed(event: DomainEvent): void {
    const data = event.data as AttentionDeliveryFailedData;
    const record = this.requireRoutedTarget(data.attentionId, event.rootRunId, data.target);
    this.assertDeliveryOpen(data.attentionId, record, data.target.runId);
    const deliveries = new Map(record.deliveries);
    deliveries.set(data.target.runId, {
      status: "failed",
      target: data.target,
      reason: data.reason,
    });
    this.records.set(data.attentionId, { ...record, deliveries });
  }

  private require(attentionId: AttentionId, rootRunId: RunId): AttentionRecord {
    const record = this.records.get(attentionId);
    if (!record) throw new Error(`Unknown attention: ${attentionId}`);
    if (record.envelope.rootRunId !== rootRunId) {
      throw new Error(`Attention ${attentionId} is outside root ${rootRunId}`);
    }
    return record;
  }

  private requireRoutedTarget(
    attentionId: AttentionId,
    rootRunId: RunId,
    target: AttentionTarget,
  ): AttentionRecord {
    const record = this.require(attentionId, rootRunId);
    const routed = record.route?.targets.find((candidate) => candidate.runId === target.runId);
    if (!routed || routed.delivery !== target.delivery) {
      throw new Error(`Attention ${attentionId} did not route to ${target.runId} as ${target.delivery}`);
    }
    return record;
  }

  private assertDeliveryOpen(
    attentionId: AttentionId,
    record: AttentionRecord,
    runId: RunId,
  ): void {
    const current = record.deliveries.get(runId);
    if (current?.status === "delivered" || current?.status === "failed") {
      throw new Error(`Attention ${attentionId} delivery to ${runId} is already terminal`);
    }
  }

  private fork(): AttentionProjection {
    const projection = new AttentionProjection();
    for (const [id, record] of this.records) {
      projection.records.set(id, {
        ...record,
        deliveries: new Map(record.deliveries),
      });
    }
    return projection;
  }
}
