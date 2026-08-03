import type {
  EvidenceId,
  EvidenceRecord,
  MemoryNote,
  MemoryNoteId,
} from "../domain/memory/model.ts";
import type { RunId } from "../domain/shared.ts";

export interface PersistedMemoryState {
  readonly evidence: readonly EvidenceRecord[];
  readonly notes: readonly MemoryNote[];
}

export interface MemoryRepository {
  load(rootRunId: RunId): Promise<PersistedMemoryState>;
  appendEvidence(record: EvidenceRecord, content: string): Promise<void>;
  appendNote(note: MemoryNote): Promise<void>;
  readEvidence(rootRunId: RunId, id: EvidenceId): Promise<string | undefined>;
  hasEvidence(rootRunId: RunId, id: EvidenceId): Promise<boolean>;
  latestNote(rootRunId: RunId, id: MemoryNoteId): Promise<MemoryNote | undefined>;
}
