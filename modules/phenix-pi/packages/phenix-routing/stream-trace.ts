import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

const PREVIEW_LIMIT = 120;

export interface StreamTraceContext {
  readonly traceId: string;
  readonly sessionId: string;
}

export type StreamTraceRecord = Readonly<Record<string, unknown>>;
export type StreamTraceSink = (record: StreamTraceRecord) => void;

const activeTraceContext = new AsyncLocalStorage<StreamTraceContext>();
const latestTraceBySession = new Map<string, string>();
const streamTraceSinks = new Set<StreamTraceSink>();

export function streamTraceEnabled(): boolean {
  return Boolean(process.env.PHENIX_PI_STREAM_TRACE) || streamTraceSinks.size > 0;
}

export function streamTraceReasoningEnabled(): boolean {
  return process.env.PHENIX_PI_STREAM_TRACE_REASONING === "1";
}

export function registerStreamTraceSink(sink: StreamTraceSink): () => void {
  streamTraceSinks.add(sink);
  return () => streamTraceSinks.delete(sink);
}

export function createStreamTraceContext(sessionId: string): StreamTraceContext {
  const context = { traceId: randomUUID(), sessionId };
  latestTraceBySession.set(sessionId, context.traceId);
  return context;
}

export function runWithStreamTraceContext<T>(context: StreamTraceContext, run: () => T): T {
  return activeTraceContext.run(context, run);
}

export function newStreamTraceId(): string {
  return activeTraceContext.getStore()?.traceId ?? randomUUID();
}

export function streamTraceIdForSession(sessionId: string): string | undefined {
  return latestTraceBySession.get(sessionId);
}

export function clearStreamTraceSession(sessionId: string): void {
  latestTraceBySession.delete(sessionId);
}

export function streamTraceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function streamTracePreview(value: string): string {
  const escaped = JSON.stringify(value.slice(0, PREVIEW_LIMIT));
  return escaped.slice(1, -1);
}

function serialized(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function contentBlockFields(block: unknown, index: number): Record<string, unknown> {
  if (typeof block !== "object" || block === null) return { index, type: "unknown" };
  const record = block as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";

  if (type === "text" && typeof record.text === "string") {
    return {
      index,
      type,
      length: record.text.length,
      sha256: streamTraceHash(record.text),
      preview: streamTracePreview(record.text),
    };
  }

  if (type === "thinking" && typeof record.thinking === "string") {
    return {
      index,
      type,
      length: record.thinking.length,
      sha256: streamTraceHash(record.thinking),
      ...(streamTraceReasoningEnabled() ? { preview: streamTracePreview(record.thinking) } : {}),
    };
  }

  if (type === "toolCall") {
    const argumentsValue = serialized(record.arguments);
    return {
      index,
      type,
      ...(typeof record.id === "string" ? { toolCallId: record.id } : {}),
      ...(typeof record.name === "string" ? { toolName: record.name } : {}),
      argumentsLength: argumentsValue.length,
      argumentsSha256: streamTraceHash(argumentsValue),
    };
  }

  return { index, type };
}

export function streamTraceMessageFields(message: unknown): Record<string, unknown> {
  if (typeof message !== "object" || message === null) return {};
  const record = message as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const value = block as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("");

  return {
    ...(typeof record.role === "string" ? { messageRole: record.role } : {}),
    ...(typeof record.provider === "string" ? { messageProvider: record.provider } : {}),
    ...(typeof record.model === "string" ? { messageModel: record.model } : {}),
    ...(typeof record.api === "string" ? { messageApi: record.api } : {}),
    ...(typeof record.stopReason === "string" ? { stopReason: record.stopReason } : {}),
    ...(typeof record.responseId === "string" ? { responseId: record.responseId } : {}),
    contentBlockCount: content.length,
    contentBlockTypes: content.map((block) =>
      typeof block === "object" &&
      block !== null &&
      typeof (block as Record<string, unknown>).type === "string"
        ? (block as Record<string, unknown>).type
        : "unknown",
    ),
    contentBlocks: content.map(contentBlockFields),
    visibleTextLength: text.length,
    visibleTextSha256: streamTraceHash(text),
  };
}

export function streamTraceEventFields(event: AssistantMessageEvent): Record<string, unknown> {
  const partial =
    event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
  const contentIndex = "contentIndex" in event ? event.contentIndex : undefined;
  const block = contentIndex === undefined ? undefined : partial.content[contentIndex];
  const partialText =
    block?.type === "text" ? block.text : block?.type === "thinking" ? block.thinking : undefined;
  const delta = "delta" in event && typeof event.delta === "string" ? event.delta : undefined;
  const exposePreview = event.type !== "thinking_delta" || streamTraceReasoningEnabled();

  return {
    eventType: event.type,
    ...(contentIndex === undefined ? {} : { contentIndex }),
    ...(delta === undefined
      ? {}
      : {
          deltaLength: delta.length,
          deltaSha256: streamTraceHash(delta),
          ...(exposePreview ? { deltaPreview: streamTracePreview(delta) } : {}),
        }),
    ...(partialText === undefined
      ? {}
      : {
          partialBlockLength: partialText.length,
          partialBlockSha256: streamTraceHash(partialText),
        }),
    ...(event.type === "done" || event.type === "error"
      ? {
          ...streamTraceMessageFields(event.type === "done" ? event.message : event.error),
        }
      : {}),
  };
}

export function writeStreamTrace(record: Record<string, unknown>): void {
  const context = activeTraceContext.getStore();
  const enriched: StreamTraceRecord = {
    ...(context ? { traceId: context.traceId, sessionId: context.sessionId } : {}),
    ...record,
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };

  for (const sink of [...streamTraceSinks]) {
    try {
      sink(enriched);
    } catch {
      // Trace projections are observational and must not alter execution.
    }
  }

  const tracePath = process.env.PHENIX_PI_STREAM_TRACE;
  if (!tracePath) return;

  try {
    mkdirSync(dirname(tracePath), { recursive: true, mode: 0o700 });
    appendFileSync(tracePath, `${JSON.stringify(enriched)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Diagnostics are observational and must never alter provider execution.
  }
}
