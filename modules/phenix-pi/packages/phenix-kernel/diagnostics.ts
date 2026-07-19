/**
 * phenix-kernel — diagnostics
 *
 * Shared diagnostic types used across the Phenix system.
 */

// ── Severity ───────────────────────────────────────────────────────────────

export type DiagnosticSeverity = "error" | "warning";

// ── Link diagnostic ────────────────────────────────────────────────────────

export interface LinkDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly source: string;
  readonly path: readonly string[];
  readonly message: string;
}

// ── Config diagnostic ──────────────────────────────────────────────────────

export interface ConfigDiagnostic {
  readonly message: string;
  readonly severity: DiagnosticSeverity;
}
