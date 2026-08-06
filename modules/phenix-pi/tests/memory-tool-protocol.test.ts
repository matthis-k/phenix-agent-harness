import assert from "node:assert/strict";
import test from "node:test";

import { parseMemoryToolRequest } from "../domain/memory/tool-protocol.ts";

test("parses every supported memory action into its exact request variant", () => {
  assert.deepEqual(parseMemoryToolRequest({ action: "snapshot" }), { action: "snapshot" });
  assert.deepEqual(parseMemoryToolRequest({ action: "health", verifyEvidence: true }), {
    action: "health",
    verifyEvidence: true,
  });
  assert.deepEqual(parseMemoryToolRequest({ action: "read", evidenceId: "evidence-1" }), {
    action: "read",
    evidenceId: "evidence-1",
  });
  assert.deepEqual(
    parseMemoryToolRequest({
      action: "note",
      kind: "decision",
      summary: "Use one canonical memory protocol",
      evidenceIds: ["evidence-1"],
    }),
    {
      action: "note",
      kind: "decision",
      summary: "Use one canonical memory protocol",
      evidenceIds: ["evidence-1"],
    },
  );
});

test("rejects missing fields, unrelated fields, and unknown actions", () => {
  assert.throws(() => parseMemoryToolRequest({ action: "read" }), /Invalid phenix_memory request/);
  assert.throws(
    () => parseMemoryToolRequest({ action: "snapshot", query: "unexpected" }),
    /Invalid phenix_memory request/,
  );
  assert.throws(() => parseMemoryToolRequest({ action: "delete" }), /Invalid phenix_memory request/);
});

test("correlates invalidation metadata with the invalidated status", () => {
  assert.throws(
    () =>
      parseMemoryToolRequest({
        action: "set_status",
        noteId: "memory-1",
        status: "active",
        invalidatedBy: "memory-2",
      }),
    /Invalid phenix_memory request/,
  );
  assert.deepEqual(
    parseMemoryToolRequest({
      action: "set_status",
      noteId: "memory-1",
      status: "invalidated",
      invalidatedBy: "memory-2",
    }),
    {
      action: "set_status",
      noteId: "memory-1",
      status: "invalidated",
      invalidatedBy: "memory-2",
    },
  );
});

test("rejects duplicate evidence and supersession references", () => {
  assert.throws(
    () =>
      parseMemoryToolRequest({
        action: "note",
        kind: "finding",
        summary: "Duplicate evidence",
        evidenceIds: ["evidence-1", "evidence-1"],
      }),
    /Invalid phenix_memory request/,
  );
});
