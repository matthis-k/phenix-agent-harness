import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidMemoryNoteTransition,
  parseMemoryLedgerEntry,
  parseMemoryNote,
} from "../domain/memory/codec.ts";

const BASE_NOTE = {
  id: "memory-1",
  rootRunId: "root-1",
  runId: "run-1",
  objectiveIds: [],
  kind: "decision",
  status: "active",
  retention: "must-retain",
  reliability: "reported",
  summary: "Use the canonical interface",
  evidenceIds: [],
  createdAt: "2026-08-03T08:00:00.000Z",
  updatedAt: "2026-08-03T08:00:00.000Z",
} as const;

test("decodes an exact atomic note batch from unknown JSON", () => {
  const entry = parseMemoryLedgerEntry({ type: "notes.recorded", value: [BASE_NOTE] });
  assert.equal(entry.type, "notes.recorded");
  if (entry.type === "notes.recorded") {
    assert.equal(entry.value[0]?.id, "memory-1");
    assert.equal(entry.value[0]?.status, "active");
  }
});

test("rejects unsupported entry types and unknown persisted fields", () => {
  assert.throws(
    () => parseMemoryLedgerEntry({ type: "note.recorded", value: BASE_NOTE }),
    /Unsupported memory ledger entry type/,
  );
  assert.throws(
    () => parseMemoryNote({ ...BASE_NOTE, unexpected: true }),
    /contains unknown fields: unexpected/,
  );
});

test("rejects invalid IDs, hashes, timestamps, and enum values", () => {
  assert.throws(() => parseMemoryNote({ ...BASE_NOTE, id: "bad id" }), /unsupported characters/);
  assert.throws(
    () => parseMemoryNote({ ...BASE_NOTE, updatedAt: "not-a-timestamp" }),
    /must be an ISO timestamp/,
  );
  assert.throws(
    () => parseMemoryNote({ ...BASE_NOTE, retention: "forever" }),
    /must be one of/,
  );
  assert.throws(
    () =>
      parseMemoryLedgerEntry({
        type: "evidence.recorded",
        value: {
          id: "evidence-1",
          rootRunId: "root-1",
          runId: "run-1",
          objectiveIds: [],
          source: { kind: "manual", actorRunId: "run-1" },
          contentHash: "not-a-hash",
          mediaType: "text/plain",
          sizeBytes: 1,
          preview: "x",
          createdAt: "2026-08-03T08:00:00.000Z",
        },
      }),
    /lowercase SHA-256 digest/,
  );
});

test("rejects invalidation metadata on non-invalidated states", () => {
  assert.throws(
    () => parseMemoryNote({ ...BASE_NOTE, invalidatedBy: "memory-2" }),
    /only valid for invalidated notes/,
  );
  const invalidated = parseMemoryNote({
    ...BASE_NOTE,
    status: "invalidated",
    invalidatedBy: "memory-2",
  });
  assert.equal(invalidated.status, "invalidated");
  if (invalidated.status === "invalidated") assert.equal(invalidated.invalidatedBy, "memory-2");
});

test("rejects duplicate note IDs within one atomic batch", () => {
  assert.throws(
    () => parseMemoryLedgerEntry({ type: "notes.recorded", value: [BASE_NOTE, BASE_NOTE] }),
    /Duplicate memory note in batch/,
  );
});

test("permits validity transitions but rejects mutation of immutable note knowledge", () => {
  const previous = parseMemoryNote(BASE_NOTE);
  const superseded = parseMemoryNote({
    ...BASE_NOTE,
    status: "superseded",
    updatedAt: "2026-08-03T08:01:00.000Z",
  });
  assert.doesNotThrow(() => assertValidMemoryNoteTransition(previous, superseded));
  assert.throws(
    () =>
      assertValidMemoryNoteTransition(
        previous,
        parseMemoryNote({
          ...BASE_NOTE,
          summary: "Rewritten knowledge",
          updatedAt: "2026-08-03T08:01:00.000Z",
        }),
      ),
    /changed immutable field summary/,
  );
});
