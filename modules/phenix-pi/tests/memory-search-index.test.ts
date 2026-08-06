import assert from "node:assert/strict";
import test from "node:test";

import {
  MemorySearchIndex,
  normalizeMemoryTerms,
} from "../application/memory-search-index.ts";
import { type MemoryNote, memoryNoteId } from "../domain/memory/model.ts";
import { runId } from "../domain/shared.ts";

const ROOT = runId("root-memory-index");
const RUN = runId("run-memory-index");

function note(id: string, summary: string, status: MemoryNote["status"] = "active"): MemoryNote {
  return {
    id: memoryNoteId(id),
    rootRunId: ROOT,
    runId: RUN,
    objectiveIds: [],
    kind: "decision",
    status,
    retention: "must-retain",
    reliability: "reported",
    summary,
    evidenceIds: [],
    createdAt: "2026-08-03T08:00:00.000Z",
    updatedAt: "2026-08-03T08:00:00.000Z",
  };
}

test("normalizes stable Unicode-aware unique query terms", () => {
  assert.deepEqual(normalizeMemoryTerms("Memory memory Architektur rust/type"), [
    "memory",
    "architektur",
    "rust/type",
  ]);
});

test("returns the union of indexed candidate postings", () => {
  const rust = note("memory-rust", "Use Rust for the durable backend");
  const qml = note("memory-qml", "Keep QML for the shell view");
  const index = new MemorySearchIndex([rust, qml]);

  assert.deepEqual(
    [...(index.candidates(normalizeMemoryTerms("rust shell")) ?? [])].sort(),
    [qml.id, rust.id].sort(),
  );
  assert.equal(index.candidates([]), undefined);
  assert.equal(index.size(), 2);
});

test("replaces postings when a validity transition is upserted", () => {
  const original = note("memory-status", "Canonical interface", "active");
  const index = new MemorySearchIndex([original]);
  index.upsert({ ...original, status: "superseded", updatedAt: "2026-08-03T08:01:00.000Z" });

  assert.deepEqual([...(index.candidates(["superseded"]) ?? [])], [original.id]);
  assert.deepEqual([...(index.candidates(["active"]) ?? [])], []);

  index.remove(original.id);
  assert.equal(index.size(), 0);
});
