import type { RunId } from "./shared.ts";

export const DIAGNOSTIC_SEVERITIES = ["trace", "info", "warning", "error"] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export interface DiagnosticArtifactReference {
  readonly ref: string;
  readonly digest: string;
  readonly bytes: number;
  readonly contentType: "application/json" | "text/plain";
}

export interface DiagnosticLogEntry {
  readonly version: 1;
  readonly timestamp: string;
  readonly severity: DiagnosticSeverity;
  readonly scope: string;
  readonly message: string;
  readonly rootRunId: RunId;
  readonly runId?: RunId;
  readonly parentRunId?: RunId;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface DiagnosticWrite {
  readonly severity: DiagnosticSeverity;
  readonly scope: string;
  readonly message: string;
  readonly rootRunId: RunId;
  readonly runId?: RunId;
  readonly parentRunId?: RunId;
  readonly timestamp?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface DiagnosticSummary {
  readonly total: number;
  readonly artifacts: number;
  readonly counts: Readonly<Record<DiagnosticSeverity, number>>;
  readonly latest?: DiagnosticLogEntry;
}

const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  trace: 0,
  info: 1,
  warning: 2,
  error: 3,
};

export function includesSeverity(value: DiagnosticSeverity, minimum: DiagnosticSeverity): boolean {
  return SEVERITY_RANK[value] >= SEVERITY_RANK[minimum];
}

export function isDiagnosticSeverity(value: string): value is DiagnosticSeverity {
  return (DIAGNOSTIC_SEVERITIES as readonly string[]).includes(value);
}

export function assertDiagnosticScope(scope: string): void {
  if (!/^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/.test(scope)) {
    throw new Error(`Invalid diagnostic scope: ${scope}`);
  }
}
