import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlRunLedger } from "../adapters/persistence/jsonl-run-ledger.ts";
import type { UnsequencedDomainEvent } from "../domain/run/events.ts";
import type { RunId } from "../domain/shared.ts";
import { LedgerConflictError } from "../ports/run-ledger.ts";

test("JSONL ledger owns one monotonic root sequence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-ledger-"));
  try {
    const ledger = new JsonlRunLedger(directory);
    const root = "root-ledger" as RunId;
    const event: UnsequencedDomainEvent = {
      eventId: "event-1",
      rootRunId: root,
      runId: root,
      revision: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "run.created",
      data: {},
    };
    const committed = await ledger.append(root, 0, [event]);
    assert.equal(committed[0]?.sequence, 1);
    assert.equal((await ledger.load(root)).length, 1);
    await assert.rejects(() => ledger.append(root, 0, [event]), LedgerConflictError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
