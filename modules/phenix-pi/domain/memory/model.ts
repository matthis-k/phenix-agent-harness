import type { ObjectiveId, RunId } from "../shared.ts";

declare const evidenceIdBrand: unique symbol;
declare const memoryNoteIdBrand: unique symbol;

export type EvidenceId<TValue extends string = string> = TValue & {
  readonly [evidenceIdBrand]: "EvidenceId";
};
export type MemoryNoteId<TValue extends string = string> = TValue & {
  readonly [memoryNoteIdBrand]: "MemoryNoteId";
};

const MAX_ID_LENGTH = 160;
const MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function evidenceId<const TValue extends string>(value: TValue): EvidenceId<TValue> {
  return validateMemoryId("Evidence ID", value) as EvidenceId<TValue>;
}

export function memoryNoteId<const TValue extends string>(value: TValue): MemoryNoteId<TValue> {
  return validateMemoryId("Memory note ID", value) as MemoryNoteId<TValue>;
}

export const MEMORY_KINDS = [
  "requirement",
  "constraint",
  "decision",
  "finding",
  "error",
  "test-result",
  "change",
  "preference",
  "procedure",
  "project-fact",
  "run-outcome",
  "observation",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryStatus = "active" | "superseded" | "invalidated" | "uncertain";
export type MemoryReliability = "observed" | "derived" | "reported";
export type MemoryRetention =
  | "must-retain"
  | "structured-lossless"
  | "summary-sufficient"
  | "ephemeral";

export type EvidenceSource =
  | {
      readonly kind: "tool-result";
      readonly toolName: string;
      readonly toolCallId: string;
    }
  | { readonly kind: "run-outcome"; readonly childRunId: RunId }
  | { readonly kind: "domain-event"; readonly eventId: string }
  | { readonly kind: "manual"; readonly actorRunId: RunId };

export interface EvidenceRecord {
  readonly id: EvidenceId;
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly objectiveIds: readonly ObjectiveId[];
  readonly source: EvidenceSource;
  readonly contentHash: string;
  readonly mediaType: "application/json" | "text/plain" | "text/markdown";
  readonly sizeBytes: number;
  readonly preview: string;
  readonly createdAt: string;
}

interface MemoryNoteBase {
  readonly id: MemoryNoteId;
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly objectiveIds: readonly ObjectiveId[];
  readonly kind: MemoryKind;
  readonly retention: MemoryRetention;
  readonly reliability: MemoryReliability;
  readonly summary: string;
  readonly subject?: string;
  readonly evidenceIds: readonly EvidenceId[];
  readonly supersedes?: readonly MemoryNoteId[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MemoryNote =
  | (MemoryNoteBase & {
      readonly status: "invalidated";
      readonly invalidatedBy?: MemoryNoteId;
    })
  | (MemoryNoteBase & {
      readonly status: Exclude<MemoryStatus, "invalidated">;
      readonly invalidatedBy?: never;
    });

export type MemoryIntegrityIssue =
  | {
      readonly kind: "ledger-tail-truncated";
      readonly line: number;
      readonly message: string;
    }
  | {
      readonly kind: "ledger-entry-corrupt";
      readonly line: number;
      readonly message: string;
    }
  | {
      readonly kind: "repository-unavailable";
      readonly message: string;
    }
  | {
      readonly kind: "evidence-missing";
      readonly evidenceId: EvidenceId;
      readonly contentHash: string;
    }
  | {
      readonly kind: "evidence-size-mismatch";
      readonly evidenceId: EvidenceId;
      readonly expectedBytes: number;
      readonly actualBytes: number;
    }
  | {
      readonly kind: "evidence-hash-mismatch";
      readonly evidenceId: EvidenceId;
      readonly expectedHash: string;
      readonly actualHash: string;
    };

export type MemoryHealthState = "healthy" | "degraded" | "corrupt" | "unavailable";

export interface MemoryHealthSnapshot {
  readonly rootRunId: RunId;
  readonly state: MemoryHealthState;
  readonly writable: boolean;
  readonly issues: readonly MemoryIntegrityIssue[];
  readonly evidenceCount: number;
  readonly noteCount: number;
  readonly activeNoteCount: number;
  readonly storedBytes: number;
  readonly ledgerBytes: number;
  readonly verifiedEvidenceCount: number;
}

export interface MemorySnapshot {
  readonly rootRunId: RunId;
  readonly health: MemoryHealthSnapshot;
  readonly evidence: readonly EvidenceRecord[];
  readonly notes: readonly MemoryNote[];
  readonly stats: {
    readonly evidenceCount: number;
    readonly activeNoteCount: number;
    readonly storedBytes: number;
  };
}

export interface MemoryRepairResult {
  readonly repaired: boolean;
  readonly removedLedgerBytes: number;
  readonly remainingIssues: readonly MemoryIntegrityIssue[];
}

export interface MemoryMaintenanceResult {
  readonly removedNoteCount: number;
  readonly removedEvidenceCount: number;
  readonly reclaimedEvidenceBytes: number;
  readonly ledgerBytesBefore: number;
  readonly ledgerBytesAfter: number;
}

export interface WorkingMemoryProjection {
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly objectivePath: readonly {
    readonly id: ObjectiveId;
    readonly title: string;
    readonly state: string;
  }[];
  readonly notes: readonly MemoryNote[];
  readonly recentEvidence: readonly EvidenceRecord[];
}

function validateMemoryId(name: string, value: string): string {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
  if (value.length > MAX_ID_LENGTH) {
    throw new Error(`${name} must not exceed ${MAX_ID_LENGTH} characters`);
  }
  if (!MEMORY_ID.test(value)) throw new Error(`${name} contains unsupported characters: ${value}`);
  return value;
}
