import type {
  DiagnosticLogEntry,
  DiagnosticSeverity,
  DiagnosticSummary,
  DiagnosticWrite,
} from "../domain/diagnostics.ts";
import type { RunId } from "../domain/shared.ts";
import type { DiagnosticLog, DiagnosticLogListener } from "../ports/diagnostic-log.ts";
import type { QueryFacade } from "./interfaces.ts";
import { summarizeRunFailures } from "./run-failure-health.ts";

/**
 * Preserves the immutable diagnostic log while projecting its summary into the
 * current run-tree health state.
 */
export class HealthDiagnosticLog implements DiagnosticLog {
  constructor(
    private readonly source: DiagnosticLog,
    private readonly queries: QueryFacade,
  ) {}

  record(input: DiagnosticWrite): Promise<DiagnosticLogEntry> {
    return this.source.record(input);
  }

  entries(
    rootRunId: RunId,
    minimum?: DiagnosticSeverity,
    limit?: number,
  ): Promise<readonly DiagnosticLogEntry[]> {
    return this.source.entries(rootRunId, minimum, limit);
  }

  export(rootRunId: RunId, minimum?: DiagnosticSeverity): Promise<string> {
    return this.source.export(rootRunId, minimum);
  }

  resolve(rootRunId: RunId, reference: string): Promise<string> {
    return this.source.resolve(rootRunId, reference);
  }

  async summary(rootRunId: RunId): Promise<DiagnosticSummary> {
    const [observed, tree] = await Promise.all([
      this.source.summary(rootRunId),
      this.queries.runTree(rootRunId),
    ]);
    const observedCounts = observed.observedCounts ?? observed.counts;
    const failures = summarizeRunFailures(tree.root);
    return {
      ...observed,
      observedCounts,
      failures,
      counts: {
        trace: observedCounts.trace,
        info: observedCounts.info,
        warning: failures.recovering,
        error: failures.terminal,
      },
    };
  }

  pathFor(rootRunId: RunId): string | undefined {
    return this.source.pathFor(rootRunId);
  }

  artifactDirectoryFor(rootRunId: RunId): string | undefined {
    return this.source.artifactDirectoryFor(rootRunId);
  }

  subscribe(listener: DiagnosticLogListener): () => void {
    return this.source.subscribe(listener);
  }

  drain(): Promise<void> {
    return this.source.drain();
  }
}
