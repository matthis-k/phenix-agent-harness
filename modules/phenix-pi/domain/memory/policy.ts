import type { MemoryRetention } from "./model.ts";

export interface MemoryContextPolicy {
  readonly defaultContextWindowTokens: number;
  readonly foldAtRatio: number;
  readonly aggressiveFoldAtRatio: number;
  readonly recentMessageTail: number;
  readonly aggressiveMessageTail: number;
  readonly normalWorkingSetNotes: number;
  readonly foldedWorkingSetNotes: number;
  readonly maxCanvasCharacters: number;
}

export interface MemoryStoragePolicy {
  readonly maximumEvidenceBytes: number;
  readonly maximumReadBytes: number;
  readonly maximumSearchResults: number;
  readonly synchronizeWrites: boolean;
  readonly verifyEvidenceOnRead: boolean;
  readonly retentionDays: Readonly<Record<MemoryRetention, number | null>>;
}

export interface MemoryPolicy {
  readonly context: MemoryContextPolicy;
  readonly storage: MemoryStoragePolicy;
  readonly captureFailureMode: "diagnose-and-continue" | "fail-session-start";
}

export const defaultMemoryPolicy = defineMemoryPolicy({
  context: {
    defaultContextWindowTokens: 128_000,
    foldAtRatio: 0.5,
    aggressiveFoldAtRatio: 0.85,
    recentMessageTail: 10,
    aggressiveMessageTail: 4,
    normalWorkingSetNotes: 10,
    foldedWorkingSetNotes: 24,
    maxCanvasCharacters: 8_000,
  },
  storage: {
    maximumEvidenceBytes: 64 * 1024 * 1024,
    maximumReadBytes: 100_000,
    maximumSearchResults: 100,
    synchronizeWrites: true,
    verifyEvidenceOnRead: true,
    retentionDays: {
      "must-retain": null,
      "structured-lossless": null,
      "summary-sufficient": 180,
      ephemeral: 14,
    },
  },
  captureFailureMode: "diagnose-and-continue",
});

export function defineMemoryPolicy<const TPolicy extends MemoryPolicy>(policy: TPolicy): TPolicy {
  requirePositiveInteger(
    policy.context.defaultContextWindowTokens,
    "memory.context.defaultContextWindowTokens",
  );
  requireRatio(policy.context.foldAtRatio, "memory.context.foldAtRatio");
  requireRatio(policy.context.aggressiveFoldAtRatio, "memory.context.aggressiveFoldAtRatio");
  if (policy.context.foldAtRatio >= policy.context.aggressiveFoldAtRatio) {
    throw new Error("memory context foldAtRatio must be below aggressiveFoldAtRatio");
  }
  requirePositiveInteger(policy.context.recentMessageTail, "memory.context.recentMessageTail");
  requirePositiveInteger(
    policy.context.aggressiveMessageTail,
    "memory.context.aggressiveMessageTail",
  );
  if (policy.context.aggressiveMessageTail > policy.context.recentMessageTail) {
    throw new Error("memory aggressiveMessageTail must not exceed recentMessageTail");
  }
  requirePositiveInteger(
    policy.context.normalWorkingSetNotes,
    "memory.context.normalWorkingSetNotes",
  );
  requirePositiveInteger(
    policy.context.foldedWorkingSetNotes,
    "memory.context.foldedWorkingSetNotes",
  );
  requirePositiveInteger(
    policy.context.maxCanvasCharacters,
    "memory.context.maxCanvasCharacters",
  );
  requirePositiveInteger(policy.storage.maximumEvidenceBytes, "memory.storage.maximumEvidenceBytes");
  requirePositiveInteger(policy.storage.maximumReadBytes, "memory.storage.maximumReadBytes");
  requirePositiveInteger(policy.storage.maximumSearchResults, "memory.storage.maximumSearchResults");
  for (const [retention, days] of Object.entries(policy.storage.retentionDays)) {
    if (days !== null) requirePositiveInteger(days, `memory.storage.retentionDays.${retention}`);
  }
  return deepFreeze(policy);
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function requireRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be greater than 0 and below 1`);
  }
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
