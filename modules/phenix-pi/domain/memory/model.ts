import type { ObjectiveId, RunId } from "../shared.ts";

export type EvidenceId = string & { readonly __brand: "EvidenceId" };
export type MemoryNoteId = string & { readonly __brand: "MemoryNoteId" };

export function evidenceId(value: string): EvidenceId {
  if (!value.trim()) throw new Error("Evidence ID must not be empty");
  return value as EvidenceId;
}

export function memoryNoteId(value: string): MemoryNoteId {
  if (!value.trim()) throw new Error("Memory note ID must not be empty");
  return value as MemoryNoteId;
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

export interface MemoryNote {
  readonly id: MemoryNoteId;
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly objectiveIds: readonly ObjectiveId[];
  readonly kind: MemoryKind;
  readonly status: MemoryStatus;
  readonly retention: MemoryRetention;
  readonly reliability: MemoryReliability;
  readonly summary: string;
  readonly subject?: string;
  readonly evidenceIds: readonly EvidenceId[];
  readonly supersedes?: readonly MemoryNoteId[];
  readonly invalidatedBy?: MemoryNoteId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemorySnapshot {
  readonly rootRunId: RunId;
  readonly evidence: readonly EvidenceRecord[];
  readonly notes: readonly MemoryNote[];
  readonly stats: {
    readonly evidenceCount: number;
    readonly activeNoteCount: number;
    readonly storedBytes: number;
  };
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
