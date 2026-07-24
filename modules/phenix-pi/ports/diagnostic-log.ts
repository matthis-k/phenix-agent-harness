import type {
  DiagnosticLogEntry,
  DiagnosticSeverity,
  DiagnosticSummary,
  DiagnosticWrite,
} from "../domain/diagnostics.ts";
import type { RunId } from "../domain/shared.ts";

export type DiagnosticLogListener = (entry: DiagnosticLogEntry) => void | Promise<void>;

export interface DiagnosticLog {
  record(input: DiagnosticWrite): Promise<DiagnosticLogEntry>;
  entries(
    rootRunId: RunId,
    minimum?: DiagnosticSeverity,
    limit?: number,
  ): Promise<readonly DiagnosticLogEntry[]>;
  export(rootRunId: RunId, minimum?: DiagnosticSeverity): Promise<string>;
  resolve(rootRunId: RunId, reference: string): Promise<string>;
  summary(rootRunId: RunId): Promise<DiagnosticSummary>;
  pathFor(rootRunId: RunId): string | undefined;
  artifactDirectoryFor(rootRunId: RunId): string | undefined;
  subscribe(listener: DiagnosticLogListener): () => void;
  drain(): Promise<void>;
}
