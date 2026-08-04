import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type HeadlessTranscriptRole = "user" | "assistant" | "thinking" | "tool" | "system";

export interface HeadlessTranscriptBlock {
  readonly id: string;
  readonly runId: string;
  readonly role: HeadlessTranscriptRole;
  readonly text: string;
  readonly complete: boolean;
}

export type HeadlessSessionEvent =
  | { readonly type: "agent.started"; readonly runId: string }
  | {
      readonly type: "agent.ended";
      readonly runId: string;
      readonly willRetry: boolean;
    }
  | { readonly type: "agent.settled"; readonly runId: string }
  | { readonly type: "transcript.appended"; readonly block: HeadlessTranscriptBlock }
  | { readonly type: "transcript.updated"; readonly block: HeadlessTranscriptBlock }
  | {
      readonly type: "tool.started";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly inputSummary: string;
    }
  | {
      readonly type: "tool.updated";
      readonly runId: string;
      readonly toolCallId: string;
      readonly output: string;
    }
  | {
      readonly type: "tool.finished";
      readonly runId: string;
      readonly toolCallId: string;
      readonly outcome: "succeeded" | "failed";
      readonly outputSummary: string;
    }
  | {
      readonly type: "queue.changed";
      readonly runId: string;
      readonly steering: readonly string[];
      readonly followUps: readonly string[];
    }
  | {
      readonly type: "compaction.changed";
      readonly runId: string;
      readonly state: "started" | "completed" | "aborted" | "failed";
      readonly reason: "manual" | "threshold" | "overflow";
      readonly message?: string;
    }
  | {
      readonly type: "retry.changed";
      readonly runId: string;
      readonly state: "waiting" | "succeeded" | "failed";
      readonly attempt: number;
      readonly maxAttempts?: number;
      readonly delayMs?: number;
      readonly message?: string;
    }
  | {
      readonly type: "session.info_changed";
      readonly runId: string;
      readonly name?: string;
    }
  | {
      readonly type: "thinking.changed";
      readonly runId: string;
      readonly level: string;
    };

export interface SessionEventSource {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export class PiSessionEventBridge {
  readonly #runId: () => string | undefined;
  readonly #publish: (event: HeadlessSessionEvent) => void | Promise<void>;
  readonly #messageIds = new WeakMap<object, string>();
  #unsubscribe: (() => void) | undefined;
  #nextMessageId = 1;

  constructor(input: {
    readonly runId: () => string | undefined;
    readonly publish: (event: HeadlessSessionEvent) => void | Promise<void>;
  }) {
    this.#runId = input.runId;
    this.#publish = input.publish;
  }

  bind(session: Pick<AgentSession, "subscribe">): void {
    this.#unsubscribe?.();
    this.#unsubscribe = session.subscribe((event) => {
      const translated = this.translate(event);
      if (!translated) return;
      void this.#publish(translated);
    });
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  translate(event: AgentSessionEvent): HeadlessSessionEvent | undefined {
    const runId = this.#runId();
    if (!runId) return undefined;

    switch (event.type) {
      case "agent_start":
        return { type: "agent.started", runId };
      case "agent_end":
        return { type: "agent.ended", runId, willRetry: event.willRetry };
      case "agent_settled":
        return { type: "agent.settled", runId };
      case "message_start":
        return {
          type: "transcript.appended",
          block: this.transcriptBlock(runId, event.message, false),
        };
      case "message_update":
        return {
          type: "transcript.updated",
          block: this.transcriptBlock(runId, event.message, false),
        };
      case "message_end":
        return {
          type: "transcript.updated",
          block: this.transcriptBlock(runId, event.message, true),
        };
      case "tool_execution_start":
        return {
          type: "tool.started",
          runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          inputSummary: summarize(event.args),
        };
      case "tool_execution_update":
        return {
          type: "tool.updated",
          runId,
          toolCallId: event.toolCallId,
          output: summarize(event.partialResult),
        };
      case "tool_execution_end":
        return {
          type: "tool.finished",
          runId,
          toolCallId: event.toolCallId,
          outcome: event.isError ? "failed" : "succeeded",
          outputSummary: summarize(event.result),
        };
      case "queue_update":
        return {
          type: "queue.changed",
          runId,
          steering: event.steering,
          followUps: event.followUp,
        };
      case "compaction_start":
        return {
          type: "compaction.changed",
          runId,
          state: "started",
          reason: event.reason,
        };
      case "compaction_end":
        return {
          type: "compaction.changed",
          runId,
          state: event.aborted ? "aborted" : event.errorMessage ? "failed" : "completed",
          reason: event.reason,
          ...(event.errorMessage ? { message: event.errorMessage } : {}),
        };
      case "auto_retry_start":
        return {
          type: "retry.changed",
          runId,
          state: "waiting",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          message: event.errorMessage,
        };
      case "auto_retry_end":
        return {
          type: "retry.changed",
          runId,
          state: event.success ? "succeeded" : "failed",
          attempt: event.attempt,
          ...(event.finalError ? { message: event.finalError } : {}),
        };
      case "session_info_changed":
        return {
          type: "session.info_changed",
          runId,
          ...(event.name === undefined ? {} : { name: event.name }),
        };
      case "thinking_level_changed":
        return { type: "thinking.changed", runId, level: event.level };
      case "turn_start":
      case "turn_end":
      case "entry_appended":
        return undefined;
      default:
        return assertNever(event);
    }
  }

  private transcriptBlock(runId: string, message: unknown, complete: boolean): HeadlessTranscriptBlock {
    return {
      id: this.messageId(message),
      runId,
      role: transcriptRole(message),
      text: messageText(message),
      complete,
    };
  }

  private messageId(message: unknown): string {
    if (isRecord(message) && typeof message.id === "string" && message.id.length > 0) {
      return message.id;
    }
    if (typeof message === "object" && message !== null) {
      const existing = this.#messageIds.get(message);
      if (existing) return existing;
      const id = `pi-message-${this.#nextMessageId++}`;
      this.#messageIds.set(message, id);
      return id;
    }
    return `pi-message-${this.#nextMessageId++}`;
  }
}

function transcriptRole(message: unknown): HeadlessTranscriptRole {
  if (!isRecord(message) || typeof message.role !== "string") return "system";
  switch (message.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool";
    case "custom":
    case "system":
      return "system";
    default:
      return "system";
  }
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return summarize(message);
  return contentText(message.content);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return summarize(content);
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!isRecord(block)) return summarize(block);
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Pi session event: ${String(value)}`);
}
