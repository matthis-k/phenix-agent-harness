import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionStore } from "../application/execution-store.ts";
import { MemoryService, MemoryUnavailableError } from "../application/memory-service.ts";
import type {
  EvidenceId,
  EvidenceRecord,
  MemoryHealthSnapshot,
  MemoryMaintenanceResult,
  MemoryNote,
  MemoryNoteId,
  MemoryRepairResult,
} from "../domain/memory/model.ts";
import { defaultMemoryPolicy, defineMemoryPolicy } from "../domain/memory/policy.ts";
import { runId, type RunId } from "../domain/shared.ts";
import type { IdGenerator } from "../ports/clock.ts";
import type { DiagnosticLog } from "../ports/diagnostic-log.ts";
import type { MemoryRepository, PersistedMemoryState } from "../ports/memory-repository.ts";

const ROOT = runId("root-memory-service");
const RUN_A = runId("run-a");
const RUN_B = runId("run-b");
const NOW = "2026-08-03T08:00:00.000Z";

test("keys provider tool-call IDs by their owning run", async () => {
  const repository = new InMemoryMemoryRepository();
  const memory = memoryService(repository);
  await memory.initializeRoot(ROOT);

  const first = await memory.captureToolResult(toolResult(RUN_A, "call-1", "first"));
  const duplicate = await memory.captureToolResult(toolResult(RUN_A, "call-1", "duplicate"));
  const secondRun = await memory.captureToolResult(toolResult(RUN_B, "call-1", "second"));

  assert.equal(duplicate.id, first.id);
  assert.notEqual(secondRun.id, first.id);
  assert.equal((await memory.evidenceForToolCall(RUN_A, "call-1"))?.id, first.id);
  assert.equal((await memory.evidenceForToolCall(RUN_B, "call-1"))?.id, secondRun.id);
  assert.equal(repository.evidence.size, 2);

  memory.shutdown();
});

test("records a new note and all superseded validity changes in one repository batch", async () => {
  const repository = new InMemoryMemoryRepository();
  const memory = memoryService(repository);
  await memory.initializeRoot(ROOT);
  await memory.captureToolResult(toolResult(RUN_A, "call-1", "evidence"));
  const before = await memory.snapshot(ROOT);
  const previous = before.notes[0];
  const evidence = before.evidence[0];
  assert.ok(previous);
  assert.ok(evidence);

  const replacement = await memory.recordNote({
    runId: RUN_A,
    kind: "decision",
    summary: "Use the production memory contract",
    evidenceIds: [evidence.id],
    supersedes: [previous.id],
    retention: "must-retain",
  });

  const batch = repository.noteBatches.at(-1);
  assert.equal(batch?.length, 2);
  assert.equal(batch?.[0]?.id, replacement.id);
  assert.equal(batch?.[1]?.id, previous.id);
  assert.equal(batch?.[1]?.status, "superseded");
  assert.equal((await memory.snapshot(ROOT)).notes.find((note) => note.id === previous.id)?.status, "superseded");

  await assert.rejects(
    memory.recordNote({
      runId: RUN_A,
      kind: "finding",
      summary: "Dangling evidence",
      evidenceIds: ["evidence-unknown" as EvidenceId],
    }),
    /Unknown memory evidence/,
  );
  await assert.rejects(memory.setStatus(RUN_A, replacement.id, "invalidated", replacement.id), /cannot invalidate itself/);

  memory.shutdown();
});

test("keeps the agent runtime usable while an unavailable memory root is explicitly read-only", async () => {
  const diagnostics = diagnosticLogStub();
  const memory = memoryService(new UnavailableMemoryRepository(), diagnostics.log);

  await memory.initializeRoot(ROOT);
  const snapshot = await memory.snapshot(ROOT);
  assert.equal(snapshot.health.state, "unavailable");
  assert.equal(snapshot.health.writable, false);
  assert.deepEqual((await memory.workingSet(RUN_A)).notes, []);
  await assert.rejects(
    memory.captureToolResult(toolResult(RUN_A, "call-1", "ignored")),
    MemoryUnavailableError,
  );
  assert.ok(diagnostics.records.some((entry) => entry.scope === "memory.health.unavailable"));

  memory.shutdown();
});

test("strict memory policy fails session initialization for an unavailable root", async () => {
  const policy = defineMemoryPolicy({
    ...defaultMemoryPolicy,
    captureFailureMode: "strict",
  });
  const memory = new MemoryService({
    repository: new UnavailableMemoryRepository(),
    store: executionStoreStub(),
    ids: new SequentialIds(),
    clock: { now: () => NOW },
    diagnostics: diagnosticLogStub().log,
    policy,
  });

  await assert.rejects(memory.initializeRoot(ROOT), MemoryUnavailableError);
  memory.shutdown();
});

test("rejects semantically corrupt note graphs before exposing a working set", async () => {
  const first = note("memory-a", ["memory-b"]);
  const second = note("memory-b", ["memory-a"]);
  const repository = new InMemoryMemoryRepository({ notes: [first, second] });
  const memory = memoryService(repository);

  await memory.initializeRoot(ROOT);
  const snapshot = await memory.snapshot(ROOT);
  assert.equal(snapshot.health.state, "corrupt");
  assert.equal(snapshot.health.writable, false);
  assert.ok(snapshot.health.issues.some((issue) => issue.kind === "note-supersession-cycle"));
  assert.deepEqual((await memory.workingSet(RUN_A)).notes, []);

  memory.shutdown();
});

function memoryService(
  repository: MemoryRepository,
  diagnostics: DiagnosticLog = diagnosticLogStub().log,
): MemoryService {
  return new MemoryService({
    repository,
    store: executionStoreStub(),
    ids: new SequentialIds(),
    clock: { now: () => NOW },
    diagnostics,
    policy: defaultMemoryPolicy,
  });
}

function toolResult(owner: RunId, toolCallId: string, content: string) {
  return {
    runId: owner,
    toolName: "read",
    toolCallId,
    input: { path: `${owner}.txt` },
    content,
    isError: false,
  } as const;
}

function note(id: string, supersedes: readonly string[]): MemoryNote {
  return {
    id: id as MemoryNoteId,
    rootRunId: ROOT,
    runId: RUN_A,
    objectiveIds: [],
    kind: "decision",
    status: "active",
    retention: "must-retain",
    reliability: "reported",
    summary: id,
    evidenceIds: [],
    supersedes: supersedes.map((value) => value as MemoryNoteId),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function executionStoreStub(): ExecutionStore {
  const runs = new Map<RunId, { readonly id: RunId; readonly parentId?: RunId }>([
    [ROOT, { id: ROOT }],
    [RUN_A, { id: RUN_A }],
    [RUN_B, { id: RUN_B }],
  ]);
  return {
    projection: {
      rootOf: () => ROOT,
      requireRun: (owner: RunId) => {
        const run = runs.get(owner);
        if (!run) throw new Error(`Unknown run: ${owner}`);
        return run;
      },
      objectiveFocuses: new Map(),
      objectives: new Map(),
      runs: new Map(),
    },
    events: {
      subscribe: () => () => undefined,
    },
  } as unknown as ExecutionStore;
}

function diagnosticLogStub(): {
  readonly log: DiagnosticLog;
  readonly records: Array<{ readonly scope: string }>;
} {
  const records: Array<{ readonly scope: string }> = [];
  return {
    records,
    log: {
      record: async (input: { readonly scope: string }) => {
        records.push({ scope: input.scope });
        return input;
      },
      entries: async () => [],
      export: async () => "",
      resolve: async () => "",
      summary: async () => ({ info: 0, warning: 0, error: 0, fatal: 0 }),
      pathFor: () => undefined,
      artifactDirectoryFor: () => undefined,
      subscribe: () => () => undefined,
      drain: async () => undefined,
    } as unknown as DiagnosticLog,
  };
}

class SequentialIds implements IdGenerator {
  private sequence = 0;

  next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

class InMemoryMemoryRepository implements MemoryRepository {
  readonly evidence = new Map<EvidenceId, EvidenceRecord>();
  readonly notes = new Map<MemoryNoteId, MemoryNote>();
  readonly payloads = new Map<EvidenceId, string>();
  readonly noteBatches: readonly MemoryNote[][] = [];
  private readonly initialIssues: PersistedMemoryState["issues"];
  private ledgerBytes = 0;

  constructor(input: Partial<PersistedMemoryState> = {}) {
    for (const item of input.evidence ?? []) this.evidence.set(item.id, item);
    for (const item of input.notes ?? []) this.notes.set(item.id, item);
    this.initialIssues = input.issues ?? [];
    this.ledgerBytes = input.ledgerBytes ?? 0;
  }

  async load(_rootRunId: RunId): Promise<PersistedMemoryState> {
    return {
      evidence: [...this.evidence.values()],
      notes: [...this.notes.values()],
      issues: this.initialIssues,
      ledgerBytes: this.ledgerBytes,
    };
  }

  async appendEvidence(record: EvidenceRecord, content: string): Promise<void> {
    this.evidence.set(record.id, record);
    this.payloads.set(record.id, content);
    this.ledgerBytes += Buffer.byteLength(content, "utf8");
  }

  async appendNotes(notes: readonly MemoryNote[]): Promise<void> {
    (this.noteBatches as MemoryNote[][]).push([...notes]);
    for (const note of notes) this.notes.set(note.id, note);
    this.ledgerBytes += Buffer.byteLength(JSON.stringify(notes), "utf8");
  }

  async readEvidence(record: EvidenceRecord): Promise<string | undefined> {
    return this.payloads.get(record.id);
  }

  async hasEvidence(_rootRunId: RunId, id: EvidenceId): Promise<boolean> {
    return this.evidence.has(id);
  }

  async latestNote(_rootRunId: RunId, id: MemoryNoteId): Promise<MemoryNote | undefined> {
    return this.notes.get(id);
  }

  async inspect(rootRunId: RunId, _verifyEvidence: boolean): Promise<MemoryHealthSnapshot> {
    return {
      rootRunId,
      state: this.initialIssues.length > 0 ? "degraded" : "healthy",
      writable: true,
      issues: this.initialIssues,
      evidenceCount: this.evidence.size,
      noteCount: this.notes.size,
      activeNoteCount: [...this.notes.values()].filter((item) => item.status === "active").length,
      storedBytes: [...this.evidence.values()].reduce((total, item) => total + item.sizeBytes, 0),
      ledgerBytes: this.ledgerBytes,
      verifiedEvidenceCount: 0,
    };
  }

  async repair(_rootRunId: RunId): Promise<MemoryRepairResult> {
    return { repaired: false, removedLedgerBytes: 0, remainingIssues: this.initialIssues };
  }

  async maintain(_rootRunId: RunId, _now: string): Promise<MemoryMaintenanceResult> {
    return {
      removedNoteCount: 0,
      removedEvidenceCount: 0,
      reclaimedEvidenceBytes: 0,
      ledgerBytesBefore: this.ledgerBytes,
      ledgerBytesAfter: this.ledgerBytes,
    };
  }
}

class UnavailableMemoryRepository extends InMemoryMemoryRepository {
  override async inspect(rootRunId: RunId): Promise<MemoryHealthSnapshot> {
    return {
      rootRunId,
      state: "unavailable",
      writable: false,
      issues: [{ kind: "repository-unavailable", message: "disk unavailable" }],
      evidenceCount: 0,
      noteCount: 0,
      activeNoteCount: 0,
      storedBytes: 0,
      ledgerBytes: 0,
      verifiedEvidenceCount: 0,
    };
  }
}
