import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionStore } from "../application/execution-store.ts";
import { MemoryService } from "../application/memory-service.ts";
import type {
  EvidenceId,
  EvidenceRecord,
  MemoryNote,
  MemoryNoteId,
} from "../domain/memory/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { IdGenerator } from "../ports/clock.ts";
import type { MemoryRepository, PersistedMemoryState } from "../ports/memory-repository.ts";

const ROOT = "root-memory-service" as RunId;
const RUN_A = "run-a" as RunId;
const RUN_B = "run-b" as RunId;

test("keys provider tool-call IDs by their owning run", async () => {
  const memory = new MemoryService({
    repository: new InMemoryMemoryRepository(),
    store: executionStoreStub(),
    ids: new SequentialIds(),
    clock: { now: () => "2026-08-03T08:00:00.000Z" },
  });

  const first = await memory.captureToolResult(toolResult(RUN_A, "call-1", "first"));
  const duplicate = await memory.captureToolResult(toolResult(RUN_A, "call-1", "duplicate"));
  const secondRun = await memory.captureToolResult(toolResult(RUN_B, "call-1", "second"));

  assert.equal(duplicate.id, first.id);
  assert.notEqual(secondRun.id, first.id);
  assert.equal((await memory.evidenceForToolCall(RUN_A, "call-1"))?.id, first.id);
  assert.equal((await memory.evidenceForToolCall(RUN_B, "call-1"))?.id, secondRun.id);

  memory.shutdown();
});

function toolResult(runId: RunId, toolCallId: string, content: string) {
  return {
    runId,
    toolName: "read",
    toolCallId,
    input: { path: `${runId}.txt` },
    content,
    isError: false,
  } as const;
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
      requireRun: (runId: RunId) => {
        const run = runs.get(runId);
        if (!run) throw new Error(`Unknown run: ${runId}`);
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

class SequentialIds implements IdGenerator {
  private sequence = 0;

  next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

class InMemoryMemoryRepository implements MemoryRepository {
  private readonly evidence = new Map<EvidenceId, EvidenceRecord>();
  private readonly notes = new Map<MemoryNoteId, MemoryNote>();
  private readonly payloads = new Map<EvidenceId, string>();

  async load(_rootRunId: RunId): Promise<PersistedMemoryState> {
    return { evidence: [...this.evidence.values()], notes: [...this.notes.values()] };
  }

  async appendEvidence(record: EvidenceRecord, content: string): Promise<void> {
    this.evidence.set(record.id, record);
    this.payloads.set(record.id, content);
  }

  async appendNote(note: MemoryNote): Promise<void> {
    this.notes.set(note.id, note);
  }

  async readEvidence(_rootRunId: RunId, id: EvidenceId): Promise<string | undefined> {
    return this.payloads.get(id);
  }

  async hasEvidence(_rootRunId: RunId, id: EvidenceId): Promise<boolean> {
    return this.evidence.has(id);
  }

  async latestNote(_rootRunId: RunId, id: MemoryNoteId): Promise<MemoryNote | undefined> {
    return this.notes.get(id);
  }
}
