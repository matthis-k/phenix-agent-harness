import assert from "node:assert/strict";
import test from "node:test";

import { logDomainEvent } from "../application/diagnostic-event-bridge.ts";
import type {
  DiagnosticLogEntry,
  DiagnosticSeverity,
  DiagnosticSummary,
  DiagnosticWrite,
} from "../domain/diagnostics.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import { runId } from "../domain/shared.ts";
import type { DiagnosticLog, DiagnosticLogListener } from "../ports/diagnostic-log.ts";

const ROOT = runId("root-diagnostic-bridge");
const CHILD = runId("run-diagnostic-bridge");

class MemoryDiagnosticLog implements DiagnosticLog {
  readonly writes: DiagnosticWrite[] = [];

  async record(input: DiagnosticWrite): Promise<DiagnosticLogEntry> {
    this.writes.push(input);
    return {
      version: 1,
      timestamp: input.timestamp ?? "2026-07-24T00:00:00.000Z",
      severity: input.severity,
      scope: input.scope,
      message: input.message,
      rootRunId: input.rootRunId,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      ...(input.fields ? { fields: input.fields } : {}),
    };
  }

  async entries(
    _rootRunId: ReturnType<typeof runId>,
    _minimum?: DiagnosticSeverity,
    _limit?: number,
  ): Promise<readonly DiagnosticLogEntry[]> {
    return [];
  }

  async export(): Promise<string> {
    return "";
  }

  async resolve(): Promise<string> {
    throw new Error("No artifacts");
  }

  async summary(): Promise<DiagnosticSummary> {
    return {
      total: this.writes.length,
      artifacts: 0,
      counts: { trace: 0, info: 0, warning: 0, error: 0 },
    };
  }

  pathFor(): string | undefined {
    return undefined;
  }

  artifactDirectoryFor(): string | undefined {
    return undefined;
  }

  subscribe(_listener: DiagnosticLogListener): () => void {
    return () => undefined;
  }

  async drain(): Promise<void> {}
}

test("domain events map to stable model, workflow, and failure diagnostics", async () => {
  const log = new MemoryDiagnosticLog();

  await logDomainEvent(
    log,
    event("run.model.resolved", {
      resolved: {
        requested: { kind: "session" },
        concrete: { kind: "concrete", provider: "opencode-go", model: "model-a" },
        thinking: "low",
        capability: "code",
        pool: "go.code",
        policyRevision: "test-policy",
      },
    }),
  );
  await logDomainEvent(log, event("workflow.node.entered", { nodeId: "implement" }));
  await logDomainEvent(
    log,
    event("run.failed", {
      outcome: {
        status: "failure",
        failure: {
          code: "provider_failed",
          message: "Upstream request failed",
          retryable: true,
        },
      },
    }),
  );

  assert.deepEqual(
    log.writes.map((write) => [write.severity, write.scope]),
    [
      ["info", "model.routing.resolved"],
      ["info", "workflow.node.entered"],
      ["error", "run.lifecycle.failed"],
    ],
  );
  assert.deepEqual(log.writes[0]?.fields, {
    provider: "opencode-go",
    model: "model-a",
    thinking: "low",
    capability: "code",
    pool: "go.code",
    policyRevision: "test-policy",
    requested: { kind: "session" },
    virtual: undefined,
  });
  assert.equal(log.writes[2]?.runId, CHILD);
  assert.equal(log.writes[2]?.rootRunId, ROOT);
});

function event(type: DomainEvent["type"], data: unknown): DomainEvent {
  return {
    eventId: `event-${type}`,
    rootRunId: ROOT,
    runId: CHILD,
    parentRunId: ROOT,
    sequence: 1,
    revision: 1,
    timestamp: "2026-07-24T00:00:00.000Z",
    type,
    data,
  };
}
