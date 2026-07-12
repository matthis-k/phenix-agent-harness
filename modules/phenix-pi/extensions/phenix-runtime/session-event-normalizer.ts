/**
 * session-event-normalizer — normalize Pi events into ChildSessionEvent
 *
 * Translates Pi AgentSessionEvent (SDK) or AgentEvent (RPC) into the
 * runtime-neutral ChildSessionEvent stream. Both backends use this
 * to produce the same normalized format.
 */

import type {
  ChildRunId,
  ChildSessionEvent,
} from "./child-session-types.ts";

// ── Pi event shapes (structural — no Pi import required here) ───────────────

interface PiAgentEvent {
  readonly type: string;
  readonly tool?: string;
  readonly toolName?: string;
  readonly name?: string;
  readonly error?: unknown;
  readonly isError?: boolean;
  readonly message?: string;
  readonly messages?: readonly unknown[];
}

// ── Normalizer ──────────────────────────────────────────────────────────────

/**
 * Normalize a Pi event into zero or more ChildSessionEvent values.
 *
 * Returns an array because some Pi events map to multiple normalized
 * events (e.g. tool_execution_end → tool.completed + possibly cycle.settled).
 * Most events map to zero or one normalized event.
 */
export function normalizePiEvent(
  runId: ChildRunId,
  raw: PiAgentEvent,
): readonly ChildSessionEvent[] {
  const events: ChildSessionEvent[] = [];

  // Tool events
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

  // agent_end — not authoritative for idle boundary (Pi may retry/compact).
  // We still forward it as an agent.event for the budget guard and observers.
  if (raw.type === "agent_end" || raw.type === "turn_end") {
    events.push({
      type: "agent.event",
      runId,
      event: raw,
    });
  }

  // Generic forwarding for other events
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

// ── Settlement detection ────────────────────────────────────────────────────

/**
 * Determine whether a Pi event indicates the current cycle has settled.
 *
 * Uses agent_settled as the authoritative runtime settlement boundary.
 * turn_end and agent_end may be followed by retries, compaction, or queued
 * continuations and therefore are observation/budget events only.
 */
export function isSettlementEvent(raw: PiAgentEvent): boolean {
  return raw.type === "agent_settled";
}

/**
 * Determine whether a Pi event indicates a provider/model failure.
 */
export function isFailureEvent(raw: PiAgentEvent): boolean {
  return (
    raw.type === "error" ||
    (raw.type === "agent_end" && raw.error != null)
  );
}
