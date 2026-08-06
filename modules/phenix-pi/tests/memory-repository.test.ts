import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  JsonlMemoryRepository,
  MemoryLedgerCorruptionError,
} from "../adapters/persistence/jsonl-memory-repository.ts";
import {
  type EvidenceRecord,
  evidenceId,
  type MemoryNote,
  memoryNoteId,
} from "../domain/memory/model.ts";
import { defaultMemoryPolicy, defineMemoryPolicy } from "../domain/memory/policy.ts";
import { runId } from "../domain/shared.ts";

const ROOT = runId("root-memory-test");
const RUN = runId("run-memory-test");
const CREATED = "2026-08-03T08:00:00.000Z";

function evidenceRecord(id: string, content: string, callId = id): EvidenceRecord {
  return {
    id: evidenceId(id),
    rootRunId: ROOT,
    runId: RUN,
    objectiveIds: [],
    source: { kind: "tool-result", toolName: "bash", toolCallId: callId },
    contentHash: createHash("sha256").update(content).digest("hex"),
    mediaType: "text/plain",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    preview: content,
    createdAt: CREATED,
  };
}

function memoryNote(
  id: string,
  evidence: readonly EvidenceRecord[],
  retention: MemoryNote["retention"] = "structured-lossless",
): MemoryNote {
  return {
    id: memoryNoteId(id),
    rootRunId: ROOT,
    runId: RUN,
    objectiveIds: [],
    kind: "test-result",
    status: "active",
    retention,
    reliability: "observed",
    summary: "cargo test succeeded",
    evidenceIds: evidence.map((item) => item.id),
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

test("persists, verifies, and reports immutable evidence separately from note metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-memory-"));
  try {
    const repository = new JsonlMemoryRepository(directory, defaultMemoryPolicy);
    const content = "all tests succeeded";
    const evidence = evidenceRecord("evidence-1", content, "call-1");
    const note = memoryNote("memory-1", [evidence]);

    await repository.appendEvidence(evidence, content);
    await repository.appendNotes([note]);

    assert.equal(await repository.readEvidence(evidence), content);
    assert.equal(await repository.hasEvidence(ROOT, evidence.id), true);
    assert.deepEqual(await repository.latestNote(ROOT, note.id), note);
    const loaded = await repository.load(ROOT);
    assert.deepEqual(loaded.evidence, [evidence]);
    assert.deepEqual(loaded.notes, [note]);
    assert.deepEqual(loaded.issues, []);
    assert.ok(loaded.ledgerBytes > 0);

    const health = await repository.inspect(ROOT, true);
    assert.equal(health.state, "healthy");
    assert.equal(health.writable, true);
    assert.equal(health.verifiedEvidenceCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses content-addressed payloads while retaining distinct evidence identities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-memory-dedup-"));
  try {
    const repository = new JsonlMemoryRepository(directory, defaultMemoryPolicy);
    const content = "same payload";
    const first = evidenceRecord("evidence-first", content, "call-first");
    const second = evidenceRecord("evidence-second", content, "call-second");

    await repository.appendEvidence(first, content);
    await repository.appendEvidence(second, content);

    const loaded = await repository.load(ROOT);
    assert.deepEqual(loaded.evidence, [first, second]);
    assert.equal(await repository.readEvidence(first), content);
    assert.equal(await repository.readEvidence(second), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commits a supersession transition as one atomic note batch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-memory-batch-"));
  try {
    const repository = new JsonlMemoryRepository(directory, defaultMemoryPolicy);
    const first = memoryNote("memory-first", []);
    await repository.appendNotes([first]);

    const replacement: MemoryNote = {
      ...memoryNote("memory-replacement", []),
      supersedes: [first.id],
    };
    const superseded: MemoryNote = {
      ...first,
      status: "superseded",
      updatedAt: "2026-08-03T08:01:00.000Z",
    };
    await repository.appendNotes([replacement, superseded]);

    const loaded = await repository.load(ROOT);
    assert.equal(loaded.notes.find((note) => note.id === first.id)?.status, "superseded");
    assert.deepEqual(loaded.notes.find((note) => note.id === replacement.id), replacement);

    await assert.rejects(
      repository.appendNotes([{ ...superseded, summary: "rewritten history" }]),
      /changed immutable field summary/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("classifies an incomplete final line as recoverable and repairs only that tail", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-memory-tail-"));
  try {
    const repository = new JsonlMemoryRepository(directory, defaultMemoryPolicy);
    const note = memoryNote("memory-tail", []);
    await repository.appendNotes([note]);
    await appendFile(ledgerPath(directory), '{"type":"notes.recorded"', "utf8");

    const loaded = await repository.load(ROOT);
    assert.equal(loaded.notes.length, 1);
    assert.equal(loaded.issues[0]?.kind, "ledger-tail-truncated");
    assert.equal((await repository.inspect(ROOT, false)).state, "degraded");

    const repair = await repository.repair(ROOT);
    assert.equal(repair.repaired, true);
    assert.ok(repair.removedLedgerBytes > 0);
    assert.deepEqual(repair.remainingIssues, []);
    assert.equal((await repository.inspect(ROOT, false)).state, "healthy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed for corruption in a complete ledger line", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-memory-corrupt-"));
  try {
    const repository = new JsonlMemoryRepository(directory, defaultMemoryPolicy);
    await repository.appendNotes([memoryNote("memory-valid", [])]);
    await appendFile(ledgerPath(directory), '{"type":"notes.recorded","value":[{}]}\n', "utf8");

    await assert.rejects(repository.load(ROOT), MemoryLedgerCorruptionError);
    const health = await repository.inspect(ROOT, false);
    assert.equal(health.state, "corrupt");
    assert.equal(health.writable, false);
    assert.equal(health.issues[0]?.kind, "ledger-entry-corrupt");
    const repair = await repository.repair(ROOT);
    assert.equal(repair.repaired, false);
    assert.equal(repair.remainingIssues[0]?.kind, "ledger-entry-corrupt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("detects payload hash or size corruption during verified health inspection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-memory-evidence-corrupt-"));
  try {
    const repository = new JsonlMemoryRepository(directory, defaultMemoryPolicy);
    const evidence = evidenceRecord("evidence-corrupt", "original");
    await repository.appendEvidence(evidence, "original");
    await writeFile(evidencePath(directory, evidence.contentHash), "tampered", "utf8");

    const health = await repository.inspect(ROOT, true);
    assert.equal(health.state, "corrupt");
    assert.equal(health.writable, false);
    assert.ok(
      health.issues.some(
        (issue) =>
          issue.kind === "evidence-size-mismatch" || issue.kind === "evidence-hash-mismatch",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies typed retention and removes evidence referenced only by expired notes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-memory-maintain-"));
  try {
    const policy = defineMemoryPolicy({
      ...defaultMemoryPolicy,
      storage: {
        ...defaultMemoryPolicy.storage,
        synchronizeWrites: false,
        retentionDays: {
          ...defaultMemoryPolicy.storage.retentionDays,
          ephemeral: 1,
        },
      },
    });
    const repository = new JsonlMemoryRepository(directory, policy);
    const evidence = evidenceRecord("evidence-expired", "temporary evidence");
    const note = memoryNote("memory-expired", [evidence], "ephemeral");
    await repository.appendEvidence(evidence, "temporary evidence");
    await repository.appendNotes([note]);

    const result = await repository.maintain(ROOT, "2026-08-05T08:00:00.000Z");
    assert.equal(result.removedNoteCount, 1);
    assert.equal(result.removedEvidenceCount, 1);
    assert.equal(result.reclaimedEvidenceBytes, evidence.sizeBytes);
    const loaded = await repository.load(ROOT);
    assert.deepEqual(loaded.notes, []);
    assert.deepEqual(loaded.evidence, []);
    await assert.rejects(readFile(evidencePath(directory, evidence.contentHash), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function rootDirectory(directory: string): string {
  const digest = createHash("sha256").update(ROOT).digest("hex").slice(0, 16);
  return path.join(directory, "memory", `${digest}-${ROOT}`);
}

function ledgerPath(directory: string): string {
  return path.join(rootDirectory(directory), "memory.jsonl");
}

function evidencePath(directory: string, hash: string): string {
  return path.join(rootDirectory(directory), "evidence", `${hash}.txt`);
}
