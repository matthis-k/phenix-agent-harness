import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import { loadNativeRunTranscriptResult } from "../extension/native-run-transcript.ts";

initTheme("dark");

test("loads a Pi session read-only as ordered native and custom-rendered chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phenix-transcript-"));
  const sessionFile = join(directory, "session.jsonl");
  const source = fixtureSession(directory);
  await writeFile(sessionFile, source);

  try {
    const loaded = await loadNativeRunTranscriptResult(fixtureNode(sessionFile), fakeTui());

    assert.equal(loaded.kind, "ready");
    if (loaded.kind !== "ready") return;
    assert.equal(loaded.value.sessionId, "session-child");
    assert.equal(loaded.value.sessionFile, sessionFile);
    const chunks = loaded.value.component.chunks ?? [];
    assert.deepEqual(
      chunks.map((chunk) => chunk.kind),
      ["user", "assistant", "tool", "result"],
    );
    assert.deepEqual(
      chunks.map((chunk) => chunk.component.constructor.name),
      ["UserMessageComponent", "AssistantMessageComponent", "ToolExecutionComponent", "Markdown"],
    );
    const rendered = loaded.value.component.render(100).join("\n");
    assert.match(rendered, /QA Report/);
    assert.match(rendered, /Repository checks passed/);
    assert.doesNotMatch(rendered, /Inspecting definitions before the tool call/);
    loaded.value.component.setThinkingVisible?.(true);
    assert.match(
      loaded.value.component.render(100).join("\n"),
      /Inspecting definitions before the tool call/,
    );
    assert.equal(await readFile(sessionFile, "utf8"), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("types an allocated transcript that Pi has not flushed yet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phenix-transcript-pending-"));
  const sessionFile = join(directory, "pending.jsonl");

  try {
    const loaded = await loadNativeRunTranscriptResult(fixtureNode(sessionFile), fakeTui());

    assert.deepEqual(loaded, {
      kind: "pending-persistence",
      runId: "run-child",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("types legacy runs without transcript references without opening a file", async () => {
  const loaded = await loadNativeRunTranscriptResult(fixtureNode(undefined, false), fakeTui());

  assert.deepEqual(loaded, { kind: "legacy", runId: "run-child" });
});

test("types allocated runs without a persisted file", async () => {
  const loaded = await loadNativeRunTranscriptResult(fixtureNode(undefined), fakeTui());

  assert.deepEqual(loaded, { kind: "pending-persistence", runId: "run-child" });
});

test("types workflow transcripts as structurally not applicable", async () => {
  const loaded = await loadNativeRunTranscriptResult(
    fixtureNode(undefined, false, "workflow"),
    fakeTui(),
  );

  assert.deepEqual(loaded, { kind: "not-applicable", reason: "workflow" });
});

function fixtureNode(
  sessionFile: string | undefined,
  allocated = true,
  kind: "agent" | "workflow" = "agent",
): RunTreeNode {
  return {
    run: {
      id: "run-child",
      kind,
      definitionId: kind === "workflow" ? "workflow.qa" : "agent.scout",
      input: {},
      outputSchemaId: "scout.output",
      requestedAt: "2026-07-27T08:00:00.000Z",
      ownership: "attached",
      state: "completed",
      revision: 1,
      compiled: {
        definitionId: kind === "workflow" ? "workflow.qa" : "agent.scout",
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
      ...(allocated
        ? {
            pi: {
              sessionId: "session-child",
              ...(sessionFile ? { sessionFile } : {}),
            },
          }
        : {}),
      activeChildren: [],
    },
    children: [],
  } as unknown as RunTreeNode;
}

function fixtureSession(cwd: string): string {
  return `${[
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
          {
            type: "thinking",
            thinking: "Inspecting definitions before the tool call",
          },
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
    {
      type: "custom",
      id: "result-1",
      parentId: "tool-result-1",
      timestamp: "2026-07-27T08:00:04.000Z",
      customType: "phenix:result-display",
      data: {
        content: "# QA Report\n\n- Repository checks passed",
        inputKind: "markdown",
        renderer: "pi-markdown",
        transform: "qa-report",
        steps: [],
        toolCallId: "tool-qa",
        toolName: "phenix_dispatch",
      },
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
