import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlRunLedger } from "../adapters/persistence/jsonl-run-ledger.ts";
import type { UnsequencedDomainEvent } from "../domain/run/events.ts";
import type { RunId } from "../domain/shared.ts";
import { LedgerConflictError } from "../ports/run-ledger.ts";

function event(rootRunId: RunId, eventId: string, revision: number): UnsequencedDomainEvent {
  return {
    eventId,
    rootRunId,
    runId: rootRunId,
    revision,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "run.created",
    data: {},
  };
}

test("JSONL ledger owns one monotonic root sequence across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-ledger-"));
  try {
    const root = "root-ledger" as RunId;
    const ledger = new JsonlRunLedger(directory);

    const first = await ledger.append(root, 0, [event(root, "event-1", 1)]);
    const second = await ledger.append(root, 1, [event(root, "event-2", 2)]);
    assert.equal(first[0]?.sequence, 1);
    assert.equal(second[0]?.sequence, 2);
    assert.deepEqual(
      (await ledger.load(root)).map((entry) => entry.sequence),
      [1, 2],
    );
    await assert.rejects(
      () => ledger.append(root, 1, [event(root, "event-conflict", 3)]),
      LedgerConflictError,
    );

    const restarted = new JsonlRunLedger(directory);
    const third = await restarted.append(root, 2, [event(root, "event-3", 3)]);
    assert.equal(third[0]?.sequence, 3);
    assert.deepEqual(
      (await restarted.load(root)).map((entry) => entry.sequence),
      [1, 2, 3],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
