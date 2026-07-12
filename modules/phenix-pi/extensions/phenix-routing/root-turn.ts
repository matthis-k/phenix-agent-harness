/**
 * Root-turn extraction adapter.
 *
 * Extracts the actual user message and a stable turn identity from the
 * Pi before_agent_start event and extension context.
 *
 * The BeforeAgentStartEvent provides systemPrompt (the fully assembled
 * system prompt containing base prompt + Project Context + injected skills +
 * tool instructions + workflow guidance), which is NOT the user message.
 *
 * The user's instruction is the last UserMessage in the conversation.
 * Messages are obtained via the "context" event (pi.on("context", ...)).
 *
 * Turn identity is derived from session metadata + message position
 * + content hash as a final fallback, so identical repeated requests
 * can still produce distinct turns.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
// Import Message types from pi-ai (resolved at Pi runtime via Nix).
import type {
  Message as _Message,
  UserMessage as _UserMessage,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";

// Re-export for convenience.
export type { _Message as Message, _UserMessage as UserMessage };

/**
 * Stable identity for one logical user turn.
 *
 * Must remain consistent across repeated before_agent_start hooks for the
 * same user message (retries, extension re-invocations), and change when
 * a genuinely new user message arrives.
 */
export interface RootTurnInput {
  /** Stable identifier for this logical turn. */
  readonly turnId: string;

  /** The user message that initiated this turn — NOT the system prompt. */
  readonly userMessage: string;
}

// ── Message helper types ────────────────────────────────────────────────────

interface MinimalTextContent {
  type: "text";
  text: string;
}

interface MinimalImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

interface MinimalUserMessage {
  role: "user";
  content: string | (MinimalTextContent | MinimalImageContent)[];
  timestamp: number;
}

interface MinimalMessage {
  role: string;
}

type MinimalMessageUnion = MinimalMessage &
  Partial<MinimalUserMessage>;

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract the user turn from a before_agent_start invocation.
 *
 * Uses the last UserMessage from the cached conversation to obtain the
 * actual user instruction, not the system prompt.
 *
 * @param messages - Conversation messages cached from the "context" event.
 * @param ctx - Extension context (for session identity).
 * @returns RootTurnInput with stable turnId and user message.
 * @throws Error with code "MISSING_USER_MESSAGE" when no user message is found.
 */
export function extractRootTurnInput(
  messages: readonly MinimalMessageUnion[],
  ctx: ExtensionContext,
): RootTurnInput {
  const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown-session";

  // ── Extract user message ────────────────────────────────────────────

  let userMessage = "";
  let userMessageIndex = -1;

  // Walk messages in reverse to find the last user message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      userMessage = extractUserContent(msg as MinimalMessageUnion & { content: MinimalUserMessage["content"] });
      userMessageIndex = i;
      break;
    }
  }

  if (!userMessage) {
    throw Object.assign(
      new Error(
        "Root turn input: could not locate a user message in the conversation.",
      ),
      { code: "MISSING_USER_MESSAGE" },
    );
  }

  // ── Derive turn ID ──────────────────────────────────────────────────

  // Preferred: session + message index creates a stable, session-scoped
  // identity within one Pi session. The content hash suffix ensures that
  // a different message at the same index produces a distinct turn, and
  // identical repeated requests at the same index are still identical turns.
  const userContentHash = createHash("sha256")
    .update(userMessage, "utf-8")
    .digest("hex")
    .slice(0, 16);

  const turnId = userMessageIndex >= 0
    ? `${sessionId}#msg${userMessageIndex}#${userContentHash}`
    : `${sessionId}#${userContentHash}`;

  return { turnId, userMessage };
}

/**
 * Extract the text content from a UserMessage.
 *
 * UserMessage.content is either a plain string or an array of
 * TextContent | ImageContent blocks.
 */
function extractUserContent(
  msg: MinimalMessageUnion & { content: MinimalUserMessage["content"] },
): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter(
      (block: MinimalTextContent | MinimalImageContent): block is MinimalTextContent =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}
