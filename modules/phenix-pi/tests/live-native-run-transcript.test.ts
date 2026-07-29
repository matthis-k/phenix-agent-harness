import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import { loadNativeRunTranscriptResult } from "../extension/native-run-transcript.ts";
import type { LiveAgentTranscriptSnapshot } from "../ports/live-agent-transcripts.ts";

initTheme("dark");

test("renders an active child transcript from live Pi messages before persistence", async () => {
  const node = fixtureNode("running");
  const loaded = await loadNativeRunTranscriptResult(
    node,
    fakeTui(),
    undefined,
    liveTranscript("Live partial response"),
    process.cwd(),
  );

  assert.equal(loaded.kind, "ready");
  if (loaded.kind !== "ready") return;
  assert.match(loaded.value.component.render(100).join("\n"), /Live partial response/);
});

test("keeps the live transcript when a completed child file is not visible yet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phenix-live-transcript-"));
  const missingFile = join(directory, "not-flushed.jsonl");
  try {
    const loaded = await loadNativeRunTranscriptResult(
      fixtureNode("completed", missingFile),
      fakeTui(),
      undefined,
      liveTranscript("Final live response", missingFile),
      directory,
    );

    assert.equal(loaded.kind, "ready");
    if (loaded.kind !== "ready") return;
    assert.match(loaded.value.component.render(100).join("\n"), /Final live response/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("switches a completed child to its durable transcript without an unavailable state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phenix-durable-transcript-"));
  const sessionFile = join(directory, "session.jsonl");
  await writeFile(sessionFile, persistedSession(directory, "Durable final response"));

  try {
    const loaded = await loadNativeRunTranscriptResult(
      fixtureNode("completed", sessionFile),
      fakeTui(),
      undefined,
      liveTranscript("Stale live response", sessionFile),
      directory,
    );

    assert.equal(loaded.kind, "ready");
    if (loaded.kind !== "ready") return;
    const rendered = loaded.value.component.render(100).join("\n");
    assert.match(rendered, /Durable final response/);
    assert.doesNotMatch(rendered, /Stale live response/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fixtureNode(state: string, sessionFile?: string): RunTreeNode {
  return {
    run: {
      id: "run-live-child",
      kind: "agent",
      definitionId: "agent.scout",
      input: {},
      outputSchemaId: "scout.output",
      requestedAt: "2026-07-29T16:00:00.000Z",
      ownership: "attached",
      state,
      revision: 1,
      compiled: {
        definitionId: "agent.scout",
        input: {},
        outputSchemaId: "scout.output",
        tools: ["read"],
        limits: { timeoutMs: 5_000 },
        capabilities: {
          invokableDefinitions: [],
          maxDepth: 1,
          mayDetach: false,
          maySend: false,
          mayCancelChildren: false,
        },
        invocation: { wait: "await" },
      },
      pi: {
        sessionId: "session-live-child",
        ...(sessionFile ? { sessionFile } : {}),
      },
      activeChildren: [],
    },
    children: [],
  } as unknown as RunTreeNode;
}

function liveTranscript(text: string, sessionFile?: string): LiveAgentTranscriptSnapshot {
  return {
    runId: "run-live-child",
    sessionId: "session-live-child",
    ...(sessionFile ? { sessionFile } : {}),
    completeHistory: true,
    messages: [assistantMessage(text)],
  } as LiveAgentTranscriptSnapshot;
}

function assistantMessage(text: string): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function persistedSession(cwd: string, text: string): string {
  return `${[
    {
      type: "session",
      version: 3,
      id: "session-live-child",
      timestamp: "2026-07-29T16:00:00.000Z",
      cwd,
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-07-29T16:00:01.000Z",
      message: assistantMessage(text),
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
}

function fakeTui(): TUI {
  return {
    terminal: {
      rows: 40,
      columns: 120,
      write: () => undefined,
    },
    requestRender: () => undefined,
  } as unknown as TUI;
}
