import type {
  EvidenceId,
  EvidenceRecord,
  MemoryHealthSnapshot,
  MemoryIntegrityIssue,
  MemoryMaintenanceResult,
  MemoryNote,
  MemoryNoteId,
  MemoryRepairResult,
} from "../domain/memory/model.ts";
import type { RunId } from "../domain/shared.ts";

export interface PersistedMemoryState {
  readonly evidence: readonly EvidenceRecord[];
  readonly notes: readonly MemoryNote[];
  readonly issues: readonly MemoryIntegrityIssue[];
  readonly ledgerBytes: number;
}

export interface MemoryRepository {
  load(rootRunId: RunId): Promise<PersistedMemoryState>;
  appendEvidence(record: EvidenceRecord, content: string): Promise<void>;
  appendNote(note: MemoryNote): Promise<void>;
  readEvidence(record: EvidenceRecord): Promise<string | undefined>;
  hasEvidence(rootRunId: RunId, id: EvidenceId): Promise<boolean>;
  latestNote(rootRunId: RunId, id: MemoryNoteId): Promise<MemoryNote | undefined>;
  inspect(rootRunId: RunId, verifyEvidence: boolean): Promise<MemoryHealthSnapshot>;
  repair(rootRunId: RunId): Promise<MemoryRepairResult>;
  maintain(rootRunId: RunId, now: string): Promise<MemoryMaintenanceResult>;
}
