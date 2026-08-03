import type { AgentMessage } from "@earendil-works/pi-agent-core";
import assert from "node:assert/strict";
import test from "node:test";

import { assembleMemoryContext } from "../adapters/pi-sdk/memory-session-extension.ts";
import type { MemoryService } from "../application/memory-service.ts";
import {
  type EvidenceRecord,
  type WorkingMemoryProjection,
  evidenceId,
  memoryNoteId,
} from "../domain/memory/model.ts";
import type { RunId } from "../domain/shared.ts";

const ROOT = "root-memory-context" as RunId;
const RUN = "run-memory-context" as RunId;

const EVIDENCE: EvidenceRecord = {
  id: evidenceId("evidence-call-1"),
  rootRunId: ROOT,
  runId: RUN,
  objectiveIds: [],
  source: { kind: "tool-result", toolName: "read", toolCallId: "call-1" },
  contentHash: "c".repeat(64),
  mediaType: "text/plain",
  sizeBytes: 12_000,
  preview: "Read a large generated source file",
  createdAt: "2026-08-03T08:00:00.000Z",
};

const WORKING_SET: WorkingMemoryProjection = {
  rootRunId: ROOT,
  runId: RUN,
  objectivePath: [
    {
      id: "objective-memory" as never,
      title: "Implement reversible memory",
      state: "wip",
    },
  ],
  notes: [
    {
      id: memoryNoteId("memory-call-1"),
      rootRunId: ROOT,
      runId: RUN,
      objectiveIds: [],
      kind: "observation",
      status: "active",
      retention: "summary-sufficient",
      reliability: "observed",
      summary: EVIDENCE.preview,
      evidenceIds: [EVIDENCE.id],
      createdAt: EVIDENCE.createdAt,
      updatedAt: EVIDENCE.createdAt,
    },
  ],
  recentEvidence: [EVIDENCE],
};

test("folds old tool results into stable evidence references while retaining conversation", async () => {
  const memory = memoryStub();
  const messages = [
    user("Initial task", 1),
    assistant("I will inspect it", 2),
    toolResult("call-1", "x".repeat(12_000), 3),
    user("Continue", 4),
    assistant("Continuing", 5),
    user("Next", 6),
    assistant("Next", 7),
    user("More", 8),
    assistant("More", 9),
    user("Again", 10),
    assistant("Again", 11),
    user("Additional", 12),
    assistant("Additional", 13),
    user("Penultimate", 14),
    assistant("Penultimate", 15),
    user("Latest request", 16),
  ];

  const assembled = await assembleMemoryContext(memory, RUN, messages, 4_000);
  const folded = assembled.find(
    (message) => message.role === "toolResult" && message.toolCallId === "call-1",
  );
  assert.ok(folded && folded.role === "toolResult");
  const foldedText = textContent(folded);
  assert.match(foldedText, /Folded tool result/);
  assert.match(foldedText, /evidence-call-1/);
  assert.ok(foldedText.length < 500);

  const injection = assembled.find(
    (message) => message.role === "custom" && message.customType === "phenix:memory-context",
  );
  assert.ok(injection && injection.role === "custom");
  assert.match(
    typeof injection.content === "string" ? injection.content : "",
    /reversible working-memory/,
  );
  assert.match(typeof injection.content === "string" ? injection.content : "", /memory-call-1/);
  assert.equal(textContent(assembled.at(-1) as AgentMessage), "Latest request");
  assert.equal(
    assembled.filter((message) => message.role === "user").length,
    messages.filter((message) => message.role === "user").length,
  );
  assert.equal(
    assembled.filter((message) => message.role === "assistant").length,
    messages.filter((message) => message.role === "assistant").length,
  );
});

test("does not replace tool results below the folding threshold", async () => {
  const messages = [user("Inspect", 1), toolResult("call-1", "small result", 2)];
  const assembled = await assembleMemoryContext(memoryStub(), RUN, messages, 100_000);
  const result = assembled.find((message) => message.role === "toolResult");
  assert.ok(result);
  assert.equal(textContent(result), "small result");
});

function memoryStub(): MemoryService {
  return {
    workingSet: async () => WORKING_SET,
    evidenceForToolCall: async (_runId: RunId, toolCallId: string) =>
      toolCallId === "call-1" ? EVIDENCE : undefined,
  } as unknown as MemoryService;
}

function user(text: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function assistant(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, text: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  } as AgentMessage;
}

function textContent(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      typeof item === "object" && item !== null && "text" in item
        ? String((item as { text: unknown }).text)
        : "",
    )
    .join("");
}
