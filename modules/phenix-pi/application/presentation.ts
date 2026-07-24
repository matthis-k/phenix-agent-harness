import { createHash } from "node:crypto";

import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";
import type { RunFactRecordedData } from "../domain/run/observability.ts";
import type { RunId } from "../domain/shared.ts";

export type PresentationSeverity = "warning" | "high" | "critical";

export interface PresentationRequest {
  readonly severity: PresentationSeverity;
  readonly title: string;
  readonly summary: string;
  readonly subject?: string;
  readonly evidence?: readonly string[];
}

export const PresentationRequestSchema = defineSchema<PresentationRequest>(
  "tool.phenix-present",
  Type.Object({
    severity: Type.Enum(["warning", "high", "critical"]),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    summary: Type.String({ minLength: 1, maxLength: 2_000 }),
    subject: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    evidence: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }),
    ),
  }),
);

export function presentationFact(
  sourceRunId: RunId,
  request: PresentationRequest,
): RunFactRecordedData {
  const presentationId = presentationFingerprint(sourceRunId, request);
  return {
    kind: "finding-reported",
    source: "agent-report",
    summary: request.summary,
    subject: request.title,
    details: {
      presentation: true,
      presentationId,
      severity: request.severity,
      title: request.title,
      ...(request.subject ? { subject: request.subject } : {}),
      ...(request.evidence?.length ? { evidence: request.evidence } : {}),
    },
    reliability: "reported",
  };
}

export function isPresentationFact(data: unknown): data is RunFactRecordedData & {
  readonly details: Readonly<Record<string, unknown>> & {
    readonly presentation: true;
    readonly presentationId: string;
    readonly severity: PresentationSeverity;
    readonly title: string;
  };
} {
  if (typeof data !== "object" || data === null) return false;
  const fact = data as RunFactRecordedData;
  const details = fact.details;
  return Boolean(
    fact.kind === "finding-reported" &&
      fact.source === "agent-report" &&
      details?.presentation === true &&
      typeof details.presentationId === "string" &&
      isPresentationSeverity(details.severity) &&
      typeof details.title === "string",
  );
}

export function formatPresentationNotice(sourceRunId: RunId, data: RunFactRecordedData): string {
  if (!isPresentationFact(data)) throw new Error("Expected a structured presentation fact");
  const evidence = Array.isArray(data.details.evidence)
    ? data.details.evidence.filter((value): value is string => typeof value === "string")
    : [];
  const subject = typeof data.details.subject === "string" ? data.details.subject : undefined;
  return [
    `[${data.details.severity.toUpperCase()}] ${data.details.title}`,
    data.summary,
    ...(subject ? [`Subject: ${subject}`] : []),
    ...evidence.map((item) => `Evidence: ${item}`),
    `Source run: ${sourceRunId}`,
    `Presentation: ${data.details.presentationId}`,
  ].join("\n");
}

export function presentationFingerprint(sourceRunId: RunId, request: PresentationRequest): string {
  const normalized = JSON.stringify({
    sourceRunId,
    severity: request.severity,
    title: request.title.trim(),
    summary: request.summary.trim(),
    subject: request.subject?.trim(),
    evidence: request.evidence?.map((item) => item.trim()),
  });
  return `presentation-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function isPresentationSeverity(value: unknown): value is PresentationSeverity {
  return value === "warning" || value === "high" || value === "critical";
}
