import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlMemoryRepository } from "../adapters/persistence/jsonl-memory-repository.ts";
import {
  type EvidenceRecord,
  type MemoryNote,
  evidenceId,
  memoryNoteId,
} from "../domain/memory/model.ts";
import type { RunId } from "../domain/shared.ts";

const ROOT = "root-memory-test" as RunId;
const RUN = "run-memory-test" as RunId;

test("persists immutable evidence separately from compact memory metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-memory-"));
  try {
    const repository = new JsonlMemoryRepository(directory);
    const evidence: EvidenceRecord = {
      id: evidenceId("evidence-1"),
      rootRunId: ROOT,
      runId: RUN,
      objectiveIds: [],
      source: { kind: "tool-result", toolName: "bash", toolCallId: "call-1" },
      contentHash: "a".repeat(64),
      mediaType: "text/plain",
      sizeBytes: 19,
      preview: "cargo test succeeded",
      createdAt: "2026-08-03T08:00:00.000Z",
    };
    const note: MemoryNote = {
      id: memoryNoteId("memory-1"),
      rootRunId: ROOT,
      runId: RUN,
      objectiveIds: [],
      kind: "test-result",
      status: "active",
      retention: "structured-lossless",
      reliability: "observed",
      summary: "cargo test succeeded",
      evidenceIds: [evidence.id],
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:00.000Z",
    };

    await repository.appendEvidence(evidence, "all tests succeeded");
    await repository.appendNote(note);

    assert.equal(await repository.readEvidence(ROOT, evidence.id), "all tests succeeded");
    assert.equal(await repository.hasEvidence(ROOT, evidence.id), true);
    assert.deepEqual(await repository.latestNote(ROOT, note.id), note);
    assert.deepEqual(await repository.load(ROOT), { evidence: [evidence], notes: [note] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses content-addressed evidence payloads while retaining distinct references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-memory-dedup-"));
  try {
    const repository = new JsonlMemoryRepository(directory);
    const base: Omit<EvidenceRecord, "id" | "source"> = {
      rootRunId: ROOT,
      runId: RUN,
      objectiveIds: [],
      contentHash: "b".repeat(64),
      mediaType: "application/json",
      sizeBytes: 12,
      preview: "same payload",
      createdAt: "2026-08-03T08:00:00.000Z",
    };
    const first: EvidenceRecord = {
      ...base,
      id: evidenceId("evidence-first"),
      source: { kind: "tool-result", toolName: "read", toolCallId: "call-first" },
    };
    const second: EvidenceRecord = {
      ...base,
      id: evidenceId("evidence-second"),
      source: { kind: "tool-result", toolName: "read", toolCallId: "call-second" },
    };

    await repository.appendEvidence(first, "same payload");
    await repository.appendEvidence(second, "same payload");

    const loaded = await repository.load(ROOT);
    assert.deepEqual(loaded.evidence, [first, second]);
    assert.equal(await repository.readEvidence(ROOT, first.id), "same payload");
    assert.equal(await repository.readEvidence(ROOT, second.id), "same payload");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
