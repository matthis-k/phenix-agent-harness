/**
 * Root-turn extraction adapter.
 *
 * Extracts the actual user message and a stable turn identity from Pi context
 * messages. The adapter accepts unknown message values because Pi's context
 * event is an external boundary; shape validation therefore belongs here.
 */

import { createHash } from "node:crypto";
import type { Message as _Message, UserMessage as _UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type { _Message as Message, _UserMessage as UserMessage };

/** Stable identity and text for one logical user turn. */
export interface RootTurnInput {
  readonly turnId: string;
  readonly userMessage: string;
}

interface RootTurnMessage {
  readonly role: string;
  readonly content?: unknown;
}

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

function isRootTurnMessage(value: unknown): value is RootTurnMessage {
  return (
    typeof value === "object" && value !== null && "role" in value && typeof value.role === "string"
  );
}

function isTextContent(value: unknown): value is TextContent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

function extractUserContent(message: RootTurnMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter(isTextContent)
    .map((block) => block.text)
    .join("\n");
}

/** Build input for a newly submitted root turn before Pi assembles provider context. */
export function createRootTurnInput(
  userMessage: string,
  sessionId: string,
  ordinal: number,
): RootTurnInput {
  if (userMessage.length === 0) {
    throw Object.assign(new Error("Root turn input: the submitted user message is empty."), {
      code: "MISSING_USER_MESSAGE",
    });
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error(`Root turn input: invalid turn ordinal ${ordinal}.`);
  }

  const userContentHash = createHash("sha256")
    .update(userMessage, "utf-8")
    .digest("hex")
    .slice(0, 16);
  return {
    turnId: `${sessionId}#turn${ordinal}#${userContentHash}`,
    userMessage,
  };
}

/**
 * Extract the final user message from a Pi context snapshot.
 *
 * This adapter is intended for context inspection only. Lifecycle code should
 * use createRootTurnInput() because compaction rewrites context positions.
 *
 * @throws an error with code `MISSING_USER_MESSAGE` when no valid user message
 * exists in the supplied context values.
 */
export function extractRootTurnInput(
  messages: readonly unknown[],
  ctx: ExtensionContext,
): RootTurnInput {
  const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown-session";

  let userMessage = "";
  let userMessageIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRootTurnMessage(message) || message.role !== "user") continue;

    userMessage = extractUserContent(message);
    if (userMessage.length === 0) continue;

    userMessageIndex = index;
    break;
  }

  if (!userMessage) {
    throw Object.assign(
      new Error("Root turn input: could not locate a user message in the conversation."),
      { code: "MISSING_USER_MESSAGE" },
    );
  }

  const userContentHash = createHash("sha256")
    .update(userMessage, "utf-8")
    .digest("hex")
    .slice(0, 16);

  const turnId =
    userMessageIndex >= 0
      ? `${sessionId}#msg${userMessageIndex}#${userContentHash}`
      : `${sessionId}#${userContentHash}`;

  return { turnId, userMessage };
}
