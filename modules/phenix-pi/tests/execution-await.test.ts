import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRunLedger } from "../adapters/persistence/in-memory-run-ledger.ts";
import { DefinitionCatalog } from "../application/catalog.ts";
import {
  type DomainEventListener,
  OrderedDomainEventBus,
} from "../application/domain-event-bus.ts";
import { ExecutionFacadeImpl } from "../application/execution-facade.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import { ROOT_CAPABILITIES, type RunRecord } from "../domain/run/model.ts";
import { definitionId, type RunId, success } from "../domain/shared.ts";
import type { IdGenerator } from "../ports/clock.ts";

class Ids implements IdGenerator {
  private value = 0;

  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${this.value}`;
  }
}

class SubscribeRaceEventBus extends OrderedDomainEventBus {
  beforeSubscribe?: () => void;

  override subscribe(listener: DomainEventListener): () => void {
    const beforeSubscribe = this.beforeSubscribe;
    this.beforeSubscribe = undefined;
    beforeSubscribe?.();
    return super.subscribe(listener);
  }
}

test("await observes an outcome committed between the initial check and subscription", async () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const clock = { now: () => timestamp };
  const ids = new Ids();
  const events = new SubscribeRaceEventBus();
  const store = new ExecutionStore({
    ledger: new InMemoryRunLedger(),
    events,
    clock,
    ids,
  });
  const execution = new ExecutionFacadeImpl({
    catalog: new DefinitionCatalog(),
    store,
    models: {
      async resolve() {
        throw new Error("not used");
      },
    },
    ids,
    clock,
  });

  const root = "root-await-race" as RunId;
  const child = "run-await-race" as RunId;
  const childDefinition = definitionId("agent.await-race");
  await execution.initializeRoot({ id: root, session: { sessionId: "root", cwd: process.cwd() } });

  const record: Omit<RunRecord, "revision" | "state"> = {
    id: child,
    parentId: root,
    kind: "agent",
    definitionId: childDefinition,
    input: {},
    outputSchemaId: "await-race.output",
    requestedAt: timestamp,
    ownership: "attached",
    compiled: {
      definitionId: childDefinition,
      input: {},
      outputSchemaId: "await-race.output",
      tools: [],
      limits: { timeoutMs: 0 },
      capabilities: ROOT_CAPABILITIES,
      invocation: { wait: "await" },
    },
  };
  await store.commit(root, [
    { runId: child, parentRunId: root, type: "run.created", data: { record } },
    {
      runId: child,
      parentRunId: root,
      type: "run.state.changed",
      data: { from: "created", to: "running" },
    },
  ]);

  const expected = success({ summary: "done" });
  events.beforeSubscribe = () => {
    const run = store.projection.requireRun(child);
    store.projection.apply({
      eventId: "event-await-race-completed",
      rootRunId: root,
      runId: child,
      parentRunId: root,
      sequence: store.sequence(root) + 1,
      revision: run.revision + 1,
      timestamp,
      type: "run.completed",
      data: { outcome: expected },
    });
  };

  assert.deepEqual(await execution.await(child), expected);
});
