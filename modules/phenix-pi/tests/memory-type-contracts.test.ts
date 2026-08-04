import assert from "node:assert/strict";
import test from "node:test";

import {
  type EvidenceId,
  evidenceId,
  type MemoryNote,
  memoryNoteId,
} from "../domain/memory/model.ts";
import type { MemoryToolRequest } from "../domain/memory/tool-protocol.ts";
import { runId } from "../domain/shared.ts";

const ROOT = runId("root-memory-types");
const RUN = runId("run-memory-types");
const literalEvidence = evidenceId("evidence-literal");
const literalAssignment: EvidenceId<"evidence-literal"> = literalEvidence;
void literalAssignment;

const baseNote = {
  id: memoryNoteId("memory-types"),
  rootRunId: ROOT,
  runId: RUN,
  objectiveIds: [],
  kind: "decision",
  retention: "must-retain",
  reliability: "reported",
  summary: "Typed memory",
  evidenceIds: [],
  createdAt: "2026-08-03T08:00:00.000Z",
  updatedAt: "2026-08-03T08:00:00.000Z",
} as const;

const validActiveNote: MemoryNote = { ...baseNote, status: "active" };
const validInvalidatedNote: MemoryNote = {
  ...baseNote,
  status: "invalidated",
  invalidatedBy: memoryNoteId("memory-replacement"),
};
void validActiveNote;
void validInvalidatedNote;

// @ts-expect-error active notes cannot retain invalidation metadata
const invalidActiveNote: MemoryNote = {
  ...baseNote,
  status: "active",
  invalidatedBy: memoryNoteId("memory-replacement"),
};
void invalidActiveNote;

const validRead: MemoryToolRequest = { action: "read", evidenceId: "evidence-1" };
const validInvalidation: MemoryToolRequest = {
  action: "set_status",
  noteId: "memory-1",
  status: "invalidated",
  invalidatedBy: "memory-2",
};
void validRead;
void validInvalidation;

// @ts-expect-error read requires an evidence ID
const invalidRead: MemoryToolRequest = { action: "read" };
void invalidRead;

// @ts-expect-error invalidatedBy is not admitted by the active transition variant
const invalidTransition: MemoryToolRequest = {
  action: "set_status",
  noteId: "memory-1",
  status: "active",
  invalidatedBy: "memory-2",
};
void invalidTransition;

test("memory compile-time contracts are included in the TypeScript gate", () => {
  assert.equal(literalEvidence, "evidence-literal");
});
