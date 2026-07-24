import type { RunSnapshot } from "../domain/run/model.ts";
import type { Outcome, RunId } from "../domain/shared.ts";

export type RunResultView = "summary" | "outcome" | "failure" | "full";

export interface ToolTransportMetrics {
  readonly sourceBytes: number;
  readonly inlineBytes: number;
  readonly omittedBytes: number;
}

export function projectOutcome(
  outcome: Outcome<unknown>,
  view: Exclude<RunResultView, "full"> = "summary",
): unknown {
  if (view === "outcome") return outcome;
  if (view === "failure" && outcome.status === "failure") return outcome.failure;
  if (outcome.status === "success") {
    return {
      status: "success",
      ...(summaryOf(outcome.value) ? { summary: summaryOf(outcome.value) } : {}),
      hasOutcome: true,
    };
  }
  if (outcome.status === "failure") {
    return {
      status: "failure",
      code: outcome.failure.code,
      message: outcome.failure.message,
      retryable: outcome.failure.retryable,
      ...(outcome.failure.causeRunId ? { causeRunId: outcome.failure.causeRunId } : {}),
      hasOutcome: true,
    };
  }
  return { status: "cancelled", reason: outcome.reason, hasOutcome: true };
}

export function projectRunSnapshot(snapshot: RunSnapshot, view: RunResultView = "summary"): unknown {
  if (view === "full") return snapshot;
  if (view === "outcome") {
    return snapshot.outcome ?? { runId: snapshot.id, status: snapshot.state, hasOutcome: false };
  }
  if (view === "failure" && snapshot.outcome?.status === "failure") {
    return {
      runId: snapshot.id,
      definition: snapshot.definitionId,
      failure: snapshot.outcome.failure,
    };
  }
  return {
    runId: snapshot.id,
    ...(snapshot.parentId ? { parentId: snapshot.parentId } : {}),
    kind: snapshot.kind,
    definition: snapshot.definitionId,
    state: snapshot.state,
    ownership: snapshot.ownership,
    outputSchemaId: snapshot.outputSchemaId,
    activeChildren: snapshot.activeChildren,
    ...(snapshot.compiled.invocation.retryOf
      ? { retryOf: snapshot.compiled.invocation.retryOf }
      : {}),
    ...(snapshot.outcome ? { outcome: projectOutcome(snapshot.outcome) } : {}),
  };
}

export function projectCompletedRun(runId: RunId, outcome: Outcome<unknown>): unknown {
  return { runId, ...asRecord(projectOutcome(outcome)) };
}

export function projectRetryResult(
  runId: RunId,
  retryOf: RunId,
  outcome: Outcome<unknown>,
): unknown {
  return { runId, retryOf, ...asRecord(projectOutcome(outcome)) };
}

export function projectDispatchResult(result: {
  readonly definition: string;
  readonly selectedBy: string;
  readonly runId: RunId;
  readonly classifierRunId?: RunId;
  readonly status: string;
  readonly outcome?: Outcome<unknown>;
}): unknown {
  return {
    definition: result.definition,
    selectedBy: result.selectedBy,
    runId: result.runId,
    ...(result.classifierRunId ? { classifierRunId: result.classifierRunId } : {}),
    status: result.status,
    ...(result.outcome ? { outcome: projectOutcome(result.outcome) } : {}),
  };
}

export function projectedToolResult(projected: unknown, source: unknown = projected): {
  readonly text: string;
  readonly details: unknown;
} {
  const text = JSON.stringify(projected);
  const metrics = transportMetrics(source, text);
  return {
    text,
    details:
      typeof projected === "object" && projected !== null && !Array.isArray(projected)
        ? { ...projected, transport: metrics }
        : { value: projected, transport: metrics },
  };
}

export function transportMetrics(source: unknown, inline: string): ToolTransportMetrics {
  const sourceBytes = jsonBytes(source);
  const inlineBytes = Buffer.byteLength(inline, "utf8");
  return {
    sourceBytes,
    inlineBytes,
    omittedBytes: Math.max(0, sourceBytes - inlineBytes),
  };
}

function summaryOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const summary = (value as { readonly summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() ? summary : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : { value };
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}
