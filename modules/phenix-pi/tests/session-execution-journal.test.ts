import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  SessionExecutionJournal,
  sanitizeSessionExecutionPayload,
} from "@matthis-k/phenix-suite/journal/session-execution-journal.ts";
import {
  clearSessionExecutionJournalRegistry,
  recordSessionExecutionTrace,
  registerSessionExecutionContext,
  sessionExecutionJournalForProject,
  sessionExecutionJournalPath,
} from "@matthis-k/phenix-suite/journal/session-execution-journal-registry.ts";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "phenix-session-journal-"));
  mkdirSync(join(root, ".git"));
  return root;
}

describe("root session execution journal", () => {
  it("assigns one durable sequence across root and child events", () => {
    const root = project();
    const filePath = join(root, "events.jsonl");
    let eventId = 0;
    const journal = new SessionExecutionJournal({
      filePath,
      now: () => "2026-07-22T00:00:00.000Z",
      createEventId: () => `event-${++eventId}`,
    });

    try {
      journal.append({
        rootSessionId: "root-session",
        sessionId: "root-session",
        actorId: "root",
        type: "root.session.started",
      });
      journal.append({
        rootSessionId: "root-session",
        sessionId: "child-session",
        parentSessionId: "root-session",
        actorId: "actor-child",
        childRunId: "child-run",
        type: "child.session.started",
      });

      const events = journal.readAll();
      assert.deepEqual(
        events.map((event) => event.sequence),
        [1, 2],
      );
      assert.deepEqual(
        events.map((event) => event.rootSessionId),
        ["root-session", "root-session"],
      );
      assert.equal(events[1]?.parentSessionId, "root-session");
      assert.equal(readFileSync(filePath, "utf8").trim().split("\n").length, 2);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("redacts secrets and reasoning while bounding oversized values", () => {
    const payload = sanitizeSessionExecutionPayload({
      authorization: "Bearer private",
      apiKey: "private-key",
      reasoning: "private chain",
      output: "x".repeat(9_000),
    });

    assert.equal(payload?.authorization, "[redacted]");
    assert.equal(payload?.apiKey, "[redacted]");
    assert.deepEqual(payload?.reasoning, {
      redacted: true,
      length: 13,
      sha256: "3a00a93c8aee8058a58e04aa5d49deafec86e55106647bb27cfa5be39101ca50",
    });
    const output = payload?.output as Readonly<Record<string, unknown>>;
    assert.equal(output.truncated, true);
    assert.equal(output.length, 9_000);
    assert.equal(typeof output.sha256, "string");
    assert.equal((output.preview as string).length, 512);
  });

  it("continues after a torn trailing JSONL record", () => {
    const root = project();
    const filePath = join(root, "events.jsonl");
    try {
      const first = new SessionExecutionJournal({ filePath });
      first.append({
        rootSessionId: "root-session",
        sessionId: "root-session",
        actorId: "root",
        type: "first",
      });
      appendFileSync(filePath, '{"schemaVersion":1,"sequence":2', "utf8");

      const recovered = new SessionExecutionJournal({ filePath });
      const event = recovered.append({
        rootSessionId: "root-session",
        sessionId: "root-session",
        actorId: "root",
        type: "recovered",
      });
      assert.equal(event.sequence, 2);
      assert.deepEqual(
        recovered.readAll().map((candidate) => candidate.type),
        ["first", "recovered"],
      );
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("routes root and child traces into the same project-local journal", () => {
    const root = project();
    try {
      clearSessionExecutionJournalRegistry();
      registerSessionExecutionContext({
        cwd: root,
        rootSessionId: "root-session",
        sessionId: "root-session",
        actorId: "root",
      });
      registerSessionExecutionContext({
        cwd: root,
        rootSessionId: "root-session",
        sessionId: "child-session",
        parentSessionId: "root-session",
        actorId: "actor-child",
        childRunId: "child-run",
      });

      recordSessionExecutionTrace({
        boundary: "root_tool_call",
        sessionId: "root-session",
        toolName: "phenix_workflow",
      });
      recordSessionExecutionTrace({
        boundary: "router_egress",
        sessionId: "child-session",
        eventType: "done",
      });

      const journal = sessionExecutionJournalForProject(root, "root-session");
      assert.equal(journal.filePath, sessionExecutionJournalPath(root, "root-session"));
      assert.deepEqual(
        journal.readAll().map((event) => [event.sequence, event.sessionId, event.type]),
        [
          [1, "root-session", "trace.root_tool_call"],
          [2, "child-session", "trace.router_egress"],
        ],
      );
    } finally {
      clearSessionExecutionJournalRegistry();
      rmSync(root, { recursive: true });
    }
  });
});
