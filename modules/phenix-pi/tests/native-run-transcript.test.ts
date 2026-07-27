import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import { loadNativeRunTranscript } from "../extension/native-run-transcript.ts";

initTheme("dark");

test("loads a Pi session read-only and composes native message components", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phenix-transcript-"));
  const sessionFile = join(directory, "session.jsonl");
  const source = fixtureSession(directory);
  await writeFile(sessionFile, source);

  try {
    const transcript = await loadNativeRunTranscript(fixtureNode(sessionFile), fakeTui());

    assert.equal(transcript.sessionId, "session-child");
    assert.equal(transcript.sessionFile, sessionFile);
    assert.equal(transcript.unavailable, undefined);
    assert.ok(transcript.component);
    assert.deepEqual(
      transcript.component.children.map((component) => component.constructor.name),
      ["UserMessageComponent", "AssistantMessageComponent", "ToolExecutionComponent"],
    );
    assert.equal(await readFile(sessionFile, "utf8"), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports runs without persisted sessions without opening a file", async () => {
  const transcript = await loadNativeRunTranscript(fixtureNode(undefined), fakeTui());

  assert.equal(transcript.component, undefined);
  assert.match(transcript.unavailable ?? "", /no persisted Pi session/i);
});

function fixtureNode(sessionFile: string | undefined): RunTreeNode {
  return {
    run: {
      id: "run-child",
      kind: "agent",
      definitionId: "agent.scout",
      input: {},
      outputSchemaId: "scout.output",
      requestedAt: "2026-07-27T08:00:00.000Z",
      ownership: "attached",
      state: "completed",
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
        sessionId: "session-child",
        ...(sessionFile ? { sessionFile } : {}),
      },
      activeChildren: [],
    },
    children: [],
  } as unknown as RunTreeNode;
}

function fixtureSession(cwd: string): string {
  return [
    {
      type: "session",
      version: 3,
      id: "session-child",
      timestamp: "2026-07-27T08:00:00.000Z",
      cwd,
    },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-07-27T08:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Inspect the workflow definitions" }],
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-07-27T08:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the definitions." },
          {
            type: "toolCall",
            id: "tool-1",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
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
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "tool-result-1",
      parentId: "assistant-1",
      timestamp: "2026-07-27T08:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "Repository documentation" }],
        details: {},
        isError: false,
        timestamp: 3,
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
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
