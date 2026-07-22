/** Normalize Pi session events into the runtime-neutral child event stream. */

import type { ChildRunId, ChildSessionEvent, SerializedError } from "./child-session-types.ts";

interface PiAgentEvent {
  readonly type: string;
  readonly tool?: string;
  readonly toolName?: string;
  readonly name?: string;
  readonly code?: unknown;
  readonly error?: unknown;
  readonly errorMessage?: unknown;
  readonly isError?: boolean;
  readonly message?: unknown;
  readonly messages?: readonly unknown[];
  readonly stopReason?: unknown;
}

function messageFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value instanceof Error && value.message.trim().length > 0) return value.message.trim();
  if (typeof value !== "object" || value === null) return undefined;

  const record = value as Record<string, unknown>;
  return (
    messageFromUnknown(record.errorMessage) ??
    messageFromUnknown(record.message) ??
    messageFromUnknown(record.error)
  );
}

function messageFromMessages(messages: readonly unknown[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messageFromUnknown(messages[index]);
    if (message) return message;
  }
  return undefined;
}

/** Preserve the concrete provider diagnostic instead of collapsing it to an abort. */
export function providerFailureFromPiEvent(raw: PiAgentEvent): SerializedError | undefined {
  if (!isFailureEvent(raw)) return undefined;
  const message =
    messageFromUnknown(raw.error) ??
    messageFromUnknown(raw.errorMessage) ??
    messageFromUnknown(raw.message) ??
    messageFromMessages(raw.messages) ??
    "Provider/model execution failed.";
  return {
    code: typeof raw.code === "string" && raw.code.length > 0 ? raw.code : "PROVIDER_FAILED",
    message,
  };
}

export function normalizePiEvent(
  runId: ChildRunId,
  raw: PiAgentEvent,
): readonly ChildSessionEvent[] {
  const events: ChildSessionEvent[] = [];

  if (raw.type === "tool_execution_start") {
    events.push({
      type: "tool.started",
      runId,
      toolName: raw.toolName ?? raw.tool ?? raw.name ?? "unknown",
    });
  }

  if (raw.type === "tool_execution_end") {
    const isError = raw.isError === true || raw.error != null;
    events.push({
      type: "tool.completed",
      runId,
      toolName: raw.toolName ?? raw.tool ?? raw.name ?? "unknown",
      isError,
    });
  }

  if (raw.type === "agent_end" || raw.type === "turn_end") {
    events.push({
      type: "agent.event",
      runId,
      event: raw,
    });
  }

  if (
    raw.type !== "tool_execution_start" &&
    raw.type !== "tool_execution_end" &&
    raw.type !== "agent_end" &&
    raw.type !== "turn_end"
  ) {
    events.push({
      type: "agent.event",
      runId,
      event: raw,
    });
  }

  return events;
}

/** Pi's authoritative overall idle boundary. */
export function isSettlementEvent(raw: PiAgentEvent): boolean {
  return raw.type === "agent_settled";
}

function nestedFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.stopReason === "error" ||
    record.error != null ||
    (typeof record.errorMessage === "string" && record.errorMessage.trim().length > 0)
  );
}

const PROVIDER_LIFECYCLE_EVENTS = new Set([
  "agent_end",
  "message_end",
  "turn_end",
  "response_end",
]);

/** Determine whether a Pi lifecycle event indicates a provider/model failure. */
export function isFailureEvent(raw: PiAgentEvent): boolean {
  if (raw.type === "error" || raw.stopReason === "error") return true;
  if (nestedFailure(raw.message)) return true;
  if (raw.messages?.some(nestedFailure)) return true;
  return (
    PROVIDER_LIFECYCLE_EVENTS.has(raw.type) &&
    (raw.error != null ||
      (typeof raw.errorMessage === "string" && raw.errorMessage.trim().length > 0))
  );
}
