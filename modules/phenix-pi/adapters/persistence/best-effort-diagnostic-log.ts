import type {
  DiagnosticLogEntry,
  DiagnosticSeverity,
  DiagnosticSummary,
  DiagnosticWrite,
} from "../../domain/diagnostics.ts";
import type { RunId } from "../../domain/shared.ts";
import type { DiagnosticLog, DiagnosticLogListener } from "../../ports/diagnostic-log.ts";

export class BestEffortDiagnosticLog implements DiagnosticLog {
  private readonly inner: DiagnosticLog;
  private reportedWriteFailure = false;

  constructor(inner: DiagnosticLog) {
    this.inner = inner;
  }

  async record(input: DiagnosticWrite): Promise<DiagnosticLogEntry> {
    try {
      return await this.inner.record(input);
    } catch (error) {
      if (!this.reportedWriteFailure) {
        this.reportedWriteFailure = true;
        console.error(
          `[phenix] diagnostic persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        version: 1,
        timestamp: input.timestamp ?? new Date().toISOString(),
        severity: input.severity,
        scope: input.scope,
        message: input.message,
        rootRunId: input.rootRunId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        ...(input.fields ? { fields: input.fields } : {}),
      };
    }
  }

  entries(
    rootRunId: RunId,
    minimum?: DiagnosticSeverity,
    limit?: number,
  ): Promise<readonly DiagnosticLogEntry[]> {
    return this.inner.entries(rootRunId, minimum, limit);
  }

  export(rootRunId: RunId, minimum?: DiagnosticSeverity): Promise<string> {
    return this.inner.export(rootRunId, minimum);
  }

  resolve(rootRunId: RunId, reference: string): Promise<string> {
    return this.inner.resolve(rootRunId, reference);
  }

  summary(rootRunId: RunId): Promise<DiagnosticSummary> {
    return this.inner.summary(rootRunId);
  }

  pathFor(rootRunId: RunId): string | undefined {
    return this.inner.pathFor(rootRunId);
  }

  artifactDirectoryFor(rootRunId: RunId): string | undefined {
    return this.inner.artifactDirectoryFor(rootRunId);
  }

  subscribe(listener: DiagnosticLogListener): () => void {
    return this.inner.subscribe(listener);
  }

  async drain(): Promise<void> {
    try {
      await this.inner.drain();
    } catch {
      // Diagnostics are not execution authority.
    }
  }
}
