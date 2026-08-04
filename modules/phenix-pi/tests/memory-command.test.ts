import assert from "node:assert/strict";
import test from "node:test";

import { parseMemoryCommand } from "../extension/memory-command.ts";

test("parses exact operational memory commands", () => {
  assert.deepEqual(parseMemoryCommand(""), { kind: "browse" });
  assert.deepEqual(parseMemoryCommand("health"), { kind: "health", verifyEvidence: false });
  assert.deepEqual(parseMemoryCommand("verify"), { kind: "health", verifyEvidence: true });
  assert.deepEqual(parseMemoryCommand("snapshot"), { kind: "snapshot" });
  assert.deepEqual(parseMemoryCommand("policy"), { kind: "policy" });
  assert.deepEqual(parseMemoryCommand("repair"), { kind: "repair" });
  assert.deepEqual(parseMemoryCommand("maintain"), { kind: "maintain" });
  assert.deepEqual(parseMemoryCommand("read evidence-1"), {
    kind: "read",
    evidenceId: "evidence-1",
  });
});

test("parses correlated status transitions", () => {
  assert.deepEqual(parseMemoryCommand("set-status memory-1 active"), {
    kind: "set-status",
    noteId: "memory-1",
    status: "active",
  });
  assert.deepEqual(parseMemoryCommand("set-status memory-1 invalidated memory-2"), {
    kind: "set-status",
    noteId: "memory-1",
    status: "invalidated",
    invalidatedBy: "memory-2",
  });
  assert.throws(
    () => parseMemoryCommand("set-status memory-1 active memory-2"),
    /only valid with status invalidated/,
  );
});

test("rejects malformed operational commands while preserving free-text browse queries", () => {
  assert.throws(() => parseMemoryCommand("read"), /Usage: \/memory read/);
  assert.throws(() => parseMemoryCommand("read evidence-1 extra"), /Usage: \/memory read/);
  assert.throws(() => parseMemoryCommand("set-status memory-1 unknown"), /Unknown memory status/);
  assert.deepEqual(parseMemoryCommand("architecture decision"), {
    kind: "browse",
    query: "architecture decision",
  });
});
