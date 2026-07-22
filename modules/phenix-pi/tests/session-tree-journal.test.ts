import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  clearSessionExecutionJournalRegistry,
  recordSessionExecutionEvent,
} from "../packages/phenix-suite/journal/session-execution-journal-registry.ts";
import { generateSessionTreeJournal } from "../packages/phenix-suite/journal/session-tree-journal.ts";

describe("merged session-tree journal", () => {
  it("merges canonical events with root and child Pi JSONL in timestamp order", () => {
    clearSessionExecutionJournalRegistry();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "phenix-journal-full-"));
    fs.writeFileSync(path.join(cwd, "flake.nix"), "{ outputs = _: {}; }\n");
    const rootFile = path.join(cwd, "root.jsonl");
    const childFile = path.join(cwd, "child.jsonl");
    fs.writeFileSync(
      rootFile,
      [
        JSON.stringify({ type: "session", id: "root-session", timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:02.000Z" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      childFile,
      [
        JSON.stringify({ type: "session", id: "child-session", timestamp: "2026-01-01T00:00:01.000Z" }),
        JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:03.000Z" }),
      ].join("\n") + "\n",
    );
    recordSessionExecutionEvent(cwd, {
      rootSessionId: "root-session",
      sessionId: "child-session",
      actorId: "child",
      type: "child.session.started",
      payload: { sessionFile: childFile },
    });

    const result = generateSessionTreeJournal({
      cwd,
      rootSessionId: "root-session",
      rootSessionFile: rootFile,
    });
    assert.equal(result.sourceFiles.length, 3);
    const records = fs
      .readFileSync(result.filePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { timestamp: string; source: { kind: string } });
    assert.equal(records.length, 5);
    assert.deepEqual(
      records.map((record) => record.timestamp),
      [...records.map((record) => record.timestamp)].sort(),
    );
    assert.ok(records.some((record) => record.source.kind === "execution-journal"));
    assert.ok(records.some((record) => record.source.kind === "pi-session"));
  });
});
