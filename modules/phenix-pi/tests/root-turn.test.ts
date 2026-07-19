import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRootTurnInput, extractRootTurnInput } from "@matthis-k/phenix-routing/root-turn.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

interface MinimalUserMessage {
  role: "user";
  content: string;
}

interface MinimalAssistantMessage {
  role: "assistant";
  content: string;
}

interface MinimalSystemMessage {
  role: "system";
  content: string;
}

type TestMessage = MinimalUserMessage | MinimalAssistantMessage | MinimalSystemMessage;
type RootTurnMessages = Parameters<typeof extractRootTurnInput>[0];

function asRootMessages(messages: readonly TestMessage[]): RootTurnMessages {
  return messages as unknown as RootTurnMessages;
}

function hasMissingUserMessageCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "MISSING_USER_MESSAGE"
  );
}

// Minimal ExtensionContext shape for testing.
function makeCtx(sessionId = "test-session") {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
    cwd: "/test/cwd",
  } as unknown as Parameters<typeof extractRootTurnInput>[1];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("RootTurnInput creation", () => {
  it("keeps identity independent of compacted context positions", () => {
    const beforeCompaction = createRootTurnInput("continue the task", "session", 3);
    const afterCompaction = createRootTurnInput("continue the task", "session", 3);

    assert.deepEqual(afterCompaction, beforeCompaction);
    assert.match(beforeCompaction.turnId, /^session#turn3#[a-f0-9]{16}$/);
  });

  it("distinguishes repeated prompts submitted as separate turns", () => {
    const first = createRootTurnInput("try again", "session", 3);
    const second = createRootTurnInput("try again", "session", 4);

    assert.notEqual(first.turnId, second.turnId);
  });

  it("rejects invalid turn ordinals", () => {
    assert.throws(() => createRootTurnInput("task", "session", 0), /invalid turn ordinal/i);
  });
});

describe("RootTurnInput extraction", () => {
  it("extracts last user message from messages array", () => {
    const messages: TestMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, what is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "Now multiply by 3" },
    ];

    const result = extractRootTurnInput(asRootMessages(messages), makeCtx());
    assert.equal(result.userMessage, "Now multiply by 3");
  });

  it("handles single user message", () => {
    const messages: TestMessage[] = [{ role: "user", content: "Do this task" }];

    const result = extractRootTurnInput(asRootMessages(messages), makeCtx());
    assert.equal(result.userMessage, "Do this task");
  });

  it("throws on empty messages array", () => {
    assert.throws(() => extractRootTurnInput([], makeCtx()), hasMissingUserMessageCode);
  });

  it("throws when no user messages in conversation", () => {
    const messages: TestMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "assistant", content: "Hi there" },
    ];
    assert.throws(
      () => extractRootTurnInput(asRootMessages(messages), makeCtx()),
      hasMissingUserMessageCode,
    );
  });

  it("generates stable turn ID for same session + message", () => {
    const messages: TestMessage[] = [{ role: "user", content: "task" }];

    const result1 = extractRootTurnInput(asRootMessages(messages), makeCtx("s1"));
    const result2 = extractRootTurnInput(asRootMessages(messages), makeCtx("s1"));
    assert.equal(result1.turnId, result2.turnId);
  });

  it("generates different turn IDs for different sessions", () => {
    const messages: TestMessage[] = [{ role: "user", content: "task" }];

    const result1 = extractRootTurnInput(asRootMessages(messages), makeCtx("s1"));
    const result2 = extractRootTurnInput(asRootMessages(messages), makeCtx("s2"));
    assert.notEqual(result1.turnId, result2.turnId);
  });

  it("generates different turn IDs for different messages", () => {
    const messages1: TestMessage[] = [{ role: "user", content: "task A" }];
    const messages2: TestMessage[] = [{ role: "user", content: "task B" }];

    const result1 = extractRootTurnInput(asRootMessages(messages1), makeCtx());
    const result2 = extractRootTurnInput(asRootMessages(messages2), makeCtx());
    assert.notEqual(result1.turnId, result2.turnId);
  });

  it("turn ID format is expected pattern", () => {
    const messages: TestMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "hello" },
    ];

    const result = extractRootTurnInput(asRootMessages(messages), makeCtx());
    // Format: {sessionId}#msg{index}#{contentHash(16)}
    assert.match(result.turnId, /^test-session#msg\d+#[a-f0-9]{16}$/);
  });

  it("handles content blocks (array form) for user messages", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello from block" }],
      },
    ] as unknown as RootTurnMessages;

    const result = extractRootTurnInput(messages, makeCtx());
    assert.ok(result.userMessage.length > 0);
    assert.match(result.userMessage, /Hello from block/);
  });

  it("handles content blocks with image skipping", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
          { type: "text", text: "Describe this image" },
        ],
      },
    ] as unknown as RootTurnMessages;

    const result = extractRootTurnInput(messages, makeCtx());
    assert.ok(result.userMessage.includes("Describe this image"));
    // image_url should be skipped, not included.
    assert.ok(!result.userMessage.includes("image_url"));
    assert.ok(!result.userMessage.includes("https://example.com"));
  });
});
