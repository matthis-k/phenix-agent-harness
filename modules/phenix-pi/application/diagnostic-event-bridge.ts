import type { DiagnosticSeverity } from "../domain/diagnostics.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import type { RunFactRecordedData } from "../domain/run/observability.ts";
import type { DiagnosticLog } from "../ports/diagnostic-log.ts";

export async function logDomainEvent(log: DiagnosticLog, event: DomainEvent): Promise<void> {
  const description = describe(event);
  await log.record({
    rootRunId: event.rootRunId,
    runId: event.runId,
    ...(event.parentRunId ? { parentRunId: event.parentRunId } : {}),
    timestamp: event.timestamp,
    severity: description.severity,
    scope: description.scope,
    message: description.message,
    ...(description.fields ? { fields: description.fields } : {}),
  });
}

interface Description {
  readonly severity: DiagnosticSeverity;
  readonly scope: string;
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

function describe(event: DomainEvent): Description {
  switch (event.type) {
    case "run.created": {
      const record = (event.data as { readonly record: Record<string, unknown> }).record;
      return {
        severity: "info",
        scope: "run.lifecycle.created",
        message: "Run created",
        fields: {
          definitionId: record.definitionId,
          kind: record.kind,
          ownership: record.ownership,
          requestedAt: record.requestedAt,
          input: record.input,
          compiled: record.compiled,
        },
      };
    }
    case "run.state.changed": {
      const data = event.data as { readonly from: string; readonly to: string };
      return {
        severity: data.to === "failed" || data.to === "orphaned" ? "error" : "trace",
        scope: "run.lifecycle.state_changed",
        message: `Run state changed ${data.from} -> ${data.to}`,
        fields: data,
      };
    }
    case "run.profile.selected":
      return {
        severity: "info",
        scope: "runtime.profile.selected",
        message: "Session profile selected",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.model.resolved": {
      const resolved = (event.data as { readonly resolved: Record<string, unknown> }).resolved;
      const concrete = resolved.concrete as Record<string, unknown> | undefined;
      return {
        severity: "info",
        scope: "model.routing.resolved",
        message: "Concrete model resolved for run",
        fields: {
          provider: concrete?.provider,
          model: concrete?.model,
          thinking: resolved.thinking,
          capability: resolved.capability,
          pool: resolved.pool,
          policyRevision: resolved.policyRevision,
          requested: resolved.requested,
          virtual: resolved.virtual,
        },
      };
    }
    case "run.model.observed":
      return {
        severity: "info",
        scope: "model.root.observed",
        message: "Root model selection observed",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.pi.bound":
      return {
        severity: "info",
        scope: "agent.session.bound",
        message: "Pi session bound to run",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.cycle.started":
      return {
        severity: "trace",
        scope: "agent.cycle.started",
        message: "Agent cycle started",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.cycle.settled":
      return {
        severity: "trace",
        scope: "agent.cycle.settled",
        message: "Agent cycle settled",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.turn.ended":
      return {
        severity: "trace",
        scope: "agent.turn.ended",
        message: "Agent turn ended",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.tool.started":
      return {
        severity: "trace",
        scope: "tool.execution.started",
        message: "Tool execution started",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.activity.changed":
      return {
        severity: "trace",
        scope: "run.activity.changed",
        message: "Run activity changed",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.fact.recorded":
      return factDescription(event.data as RunFactRecordedData);
    case "run.input.amended":
      return {
        severity: "trace",
        scope: "runtime.input.amended",
        message: "Root input amended",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.output.submitted":
      return {
        severity: "info",
        scope: "run.output.submitted",
        message: "Typed run output submitted",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.output.rejected":
      return {
        severity: "warning",
        scope: "run.output.rejected",
        message: "Typed run output rejected",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "run.completed":
      return terminalDescription("info", "run.lifecycle.completed", "Run completed", event.data);
    case "run.failed":
      return terminalDescription("error", "run.lifecycle.failed", "Run failed", event.data);
    case "run.cancelled":
      return terminalDescription("warning", "run.lifecycle.cancelled", "Run cancelled", event.data);
    case "run.orphaned":
      return terminalDescription("error", "run.lifecycle.orphaned", "Run orphaned", event.data);
    case "run.reparented":
      return {
        severity: "info",
        scope: "run.lifecycle.reparented",
        message: "Run ownership changed",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "attention.received":
      return attentionDescription(
        "trace",
        "attention.received",
        "Follow-up attention received",
        event.data,
      );
    case "attention.routed":
      return attentionDescription(
        "info",
        "attention.routed",
        "Follow-up attention routed",
        event.data,
      );
    case "attention.routing.failed":
      return attentionDescription(
        "warning",
        "attention.routing.failed",
        "Follow-up attention routing failed",
        event.data,
      );
    case "attention.delivery.deferred":
      return attentionDescription(
        "info",
        "attention.delivery.deferred",
        "Attention delivery deferred until the target session is ready",
        event.data,
      );
    case "attention.delivered":
      return attentionDescription(
        "info",
        "attention.delivery.delivered",
        "Attention delivered to active agent",
        event.data,
      );
    case "attention.delivery.failed":
      return attentionDescription(
        "warning",
        "attention.delivery.failed",
        "Attention delivery failed",
        event.data,
      );
    case "workflow.node.entered":
      return {
        severity: "info",
        scope: "workflow.node.entered",
        message: "Workflow node entered",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "workflow.node.completed":
      return {
        severity: "info",
        scope: "workflow.node.completed",
        message: "Workflow node completed",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "workflow.transition.taken":
      return {
        severity: "info",
        scope: "workflow.transition.taken",
        message: "Workflow transition taken",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "task.local.created":
      return {
        severity: "trace",
        scope: "task.local.created",
        message: "Local task created",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "task.local.state.changed":
      return {
        severity: "trace",
        scope: "task.local.state_changed",
        message: "Local task state changed",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    case "task.progress.appended":
      return {
        severity: "trace",
        scope: "task.progress.appended",
        message: "Task progress appended",
        fields: event.data as Readonly<Record<string, unknown>>,
      };
    default:
      return {
        severity: "trace",
        scope: "runtime.event.observed",
        message: `Observed ${event.type}`,
        fields: { type: event.type, data: event.data },
      };
  }
}

function factDescription(data: RunFactRecordedData): Description {
  const severity: DiagnosticSeverity =
    data.kind === "error-observed"
      ? "error"
      : data.kind === "finding-reported" || data.kind === "decision-reported"
        ? "info"
        : "trace";
  return {
    severity,
    scope: `fact.${data.kind.replaceAll("-", "_")}.recorded`,
    message: data.summary,
    fields: {
      kind: data.kind,
      source: data.source,
      subject: data.subject,
      reliability: data.reliability,
      details: data.details,
      provenance: data.provenance,
    },
  };
}

function attentionDescription(
  severity: DiagnosticSeverity,
  scope: string,
  message: string,
  data: unknown,
): Description {
  return { severity, scope, message, fields: data as Readonly<Record<string, unknown>> };
}

function terminalDescription(
  severity: DiagnosticSeverity,
  scope: string,
  message: string,
  data: unknown,
): Description {
  return { severity, scope, message, fields: { terminal: data } };
}
