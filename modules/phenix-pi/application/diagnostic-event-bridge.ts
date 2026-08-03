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
      const { record } = event.data;
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
    case "run.state.changed":
      return {
        severity:
          event.data.to === "failed" || event.data.to === "orphaned" ? "error" : "trace",
        scope: "run.lifecycle.state_changed",
        message: `Run state changed ${event.data.from} -> ${event.data.to}`,
        fields: { ...event.data },
      };
    case "run.profile.selected":
      return {
        severity: "info",
        scope: "runtime.profile.selected",
        message: "Session profile selected",
        fields: { ...event.data },
      };
    case "run.model.resolved": {
      const { resolved } = event.data;
      return {
        severity: "info",
        scope: "model.routing.resolved",
        message: "Concrete model resolved for run",
        fields: {
          provider: resolved.concrete.provider,
          model: resolved.concrete.model,
          thinking: resolved.thinking,
          capability: resolved.capability,
          pool: resolved.pool,
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
        fields: { ...event.data },
      };
    case "run.pi.bound":
      return {
        severity: "info",
        scope: "agent.session.bound",
        message: "Pi session bound to run",
        fields: { ...event.data },
      };
    case "run.cycle.started":
      return {
        severity: "trace",
        scope: "agent.cycle.started",
        message: "Agent cycle started",
        fields: { ...event.data },
      };
    case "run.cycle.settled":
      return {
        severity: "trace",
        scope: "agent.cycle.settled",
        message: "Agent cycle settled",
        fields: { ...event.data },
      };
    case "run.turn.ended":
      return {
        severity: "trace",
        scope: "agent.turn.ended",
        message: "Agent turn ended",
        fields: {},
      };
    case "run.tool.started":
      return {
        severity: "trace",
        scope: "tool.execution.started",
        message: "Tool execution started",
        fields: { ...event.data },
      };
    case "run.activity.changed":
      return {
        severity: "trace",
        scope: "run.activity.changed",
        message: "Run activity changed",
        fields: { ...event.data },
      };
    case "run.fact.recorded":
      return factDescription(event.data);
    case "run.input.amended":
      return {
        severity: "trace",
        scope: "runtime.input.amended",
        message: "Root input amended",
        fields: { ...event.data },
      };
    case "run.output.submitted":
      return {
        severity: "info",
        scope: "run.output.submitted",
        message: "Typed run output submitted",
        fields: { ...event.data },
      };
    case "run.output.rejected":
      return {
        severity: "warning",
        scope: "run.output.rejected",
        message: "Typed run output rejected",
        fields: { ...event.data },
      };
    case "run.budget.suspended":
      return {
        severity: "warning",
        scope: "agent.budget.suspended",
        message: `Agent session budget-suspended [${event.data.failure.code}]: ${event.data.failure.message}`,
        fields: { ...event.data },
      };
    case "run.budget.resumed":
      return {
        severity: "info",
        scope: "agent.budget.resumed",
        message: "Agent session resumed with increased limits",
        fields: { ...event.data },
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
        fields: { ...event.data },
      };
    case "attention.received":
      return structuredDescription(
        "trace",
        "attention.received",
        "Follow-up attention received",
        event.data,
      );
    case "attention.routed":
      return structuredDescription(
        "info",
        "attention.routed",
        "Follow-up attention routed",
        event.data,
      );
    case "attention.routing.failed":
      return structuredDescription(
        "warning",
        "attention.routing.failed",
        "Follow-up attention routing failed",
        event.data,
      );
    case "attention.delivery.deferred":
      return structuredDescription(
        "info",
        "attention.delivery.deferred",
        "Attention delivery deferred until the target session is ready",
        event.data,
      );
    case "attention.delivered":
      return structuredDescription(
        "info",
        "attention.delivery.delivered",
        "Attention delivered to active agent",
        event.data,
      );
    case "attention.delivery.failed":
      return structuredDescription(
        "warning",
        "attention.delivery.failed",
        "Attention delivery failed",
        event.data,
      );
    case "workflow.node.entered":
      return structuredDescription(
        "info",
        "workflow.node.entered",
        "Workflow node entered",
        event.data,
      );
    case "workflow.node.completed":
      return structuredDescription(
        "info",
        "workflow.node.completed",
        "Workflow node completed",
        event.data,
      );
    case "workflow.transition.taken":
      return structuredDescription(
        "info",
        "workflow.transition.taken",
        "Workflow transition taken",
        event.data,
      );
    case "workflow.checkpoint.saved":
      return {
        severity: "trace",
        scope: "workflow.checkpoint.saved",
        message: "Workflow replay checkpoint saved",
        fields: {
          definitionId: event.data.definitionId,
          definitionFingerprint: event.data.definitionFingerprint,
          throughSequence: event.data.throughSequence,
          snapshotFingerprint: event.data.snapshotFingerprint,
          activations: event.data.snapshot.activations.length,
          resultNodes: event.data.snapshot.results.length,
          transitions: event.data.snapshot.transitionCounts.length,
        },
      };
    case "task.local.created":
      return structuredDescription(
        "trace",
        "task.local.created",
        "Local task created",
        event.data,
      );
    case "task.local.state.changed":
      return structuredDescription(
        "trace",
        "task.local.state_changed",
        "Local task state changed",
        event.data,
      );
    case "task.progress.appended":
      return structuredDescription(
        "trace",
        "task.progress.appended",
        "Task progress appended",
        event.data,
      );
    case "objective.created":
      return structuredDescription(
        "info",
        "objective.created",
        "Objective created",
        event.data,
      );
    case "objective.state.changed":
      return structuredDescription(
        "info",
        "objective.state_changed",
        "Objective state changed",
        event.data,
      );
    case "objective.focus.changed":
      return structuredDescription(
        "trace",
        "objective.focus_changed",
        "Objective focus changed",
        event.data,
      );
    case "objective.progress.appended":
      return structuredDescription(
        "trace",
        "objective.progress_appended",
        "Objective progress appended",
        event.data,
      );
    default:
      return assertNever(event);
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

function structuredDescription(
  severity: DiagnosticSeverity,
  scope: string,
  message: string,
  data: object,
): Description {
  return { severity, scope, message, fields: { ...data } };
}

function terminalDescription(
  severity: DiagnosticSeverity,
  scope: string,
  message: string,
  data: object,
): Description {
  return { severity, scope, message, fields: { terminal: data } };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled domain event: ${JSON.stringify(value)}`);
}
