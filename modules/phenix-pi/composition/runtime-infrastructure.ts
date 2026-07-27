import { randomUUID } from "node:crypto";
import path from "node:path";

import type { EventBus } from "@earendil-works/pi-coding-agent";

import { JsonlDiagnosticLog } from "../adapters/persistence/jsonl-diagnostic-log.ts";
import { JsonlRunLedger } from "../adapters/persistence/jsonl-run-ledger.ts";
import { ProcessLocalOperationRunner } from "../adapters/process/local-operation-runner.ts";
import { logDomainEvent } from "../application/diagnostic-event-bridge.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import type { SessionProfileFacade } from "../application/interfaces.ts";
import { SessionProfileFacadeImpl } from "../application/session-profile-facade.ts";
import type { IdGenerator } from "../ports/clock.ts";
import { systemClock } from "../ports/clock.ts";
import type { DiagnosticLog } from "../ports/diagnostic-log.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";
import type { RunLedger } from "../ports/run-ledger.ts";
import type { PhenixHostServices } from "./host-services.ts";

export interface RuntimeInfrastructure {
  readonly ids: IdGenerator;
  readonly diagnostics: DiagnosticLog;
  readonly events: OrderedDomainEventBus;
  readonly ledger: RunLedger;
  readonly store: ExecutionStore;
  readonly unsubscribeDiagnostics: () => void;
  readonly profiles: SessionProfileFacade;
  readonly operations: LocalOperationRunner;
}

export function createRuntimeInfrastructure(host: PhenixHostServices): RuntimeInfrastructure {
  const ids = host.ids ?? new CryptoIdGenerator();
  const stateDir = host.stateDir ?? path.join(host.cwd, ".phenix-agent-state");
  const diagnostics = host.diagnostics ?? new JsonlDiagnosticLog(stateDir);
  const events = createDomainEventBus(diagnostics);
  const ledger = host.ledger ?? new JsonlRunLedger(stateDir);
  const store = new ExecutionStore({ ledger, events, clock: systemClock, ids });
  const unsubscribeDiagnostics = events.subscribe((event) => logDomainEvent(diagnostics, event));
  const profiles = new SessionProfileFacadeImpl(store);
  const operations = new ProcessLocalOperationRunner();

  return {
    ids,
    diagnostics,
    events,
    ledger,
    store,
    unsubscribeDiagnostics,
    profiles,
    operations,
  };
}

export function createPiEventBridge(
  eventBus: EventBus | undefined,
  events: OrderedDomainEventBus,
): () => void {
  if (!eventBus) return () => undefined;
  return events.subscribe((event) => {
    eventBus.emit("phenix:domain-event", event);
  });
}

function createDomainEventBus(diagnostics: DiagnosticLog): OrderedDomainEventBus {
  return new OrderedDomainEventBus({
    onSubscriberError: async ({ event, error }) => {
      try {
        await diagnostics.record({
          rootRunId: event.rootRunId,
          runId: event.runId,
          ...(event.parentRunId ? { parentRunId: event.parentRunId } : {}),
          severity: "error",
          scope: "runtime.event.subscriber_failed",
          message: `Domain event subscriber failed for ${event.type}`,
          fields: { eventType: event.type, sequence: event.sequence, error },
        });
      } catch {
        console.error(
          `[phenix] domain event subscriber failed for ${event.type}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
}

class CryptoIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }
}
