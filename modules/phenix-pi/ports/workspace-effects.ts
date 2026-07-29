import type { RunId } from "../domain/shared.ts";
import type { WorkspaceError } from "../domain/workspace/errors.ts";
import type { WorkspaceEffect, WorkspaceSnapshotEnvelope } from "../domain/workspace/events.ts";
import type {
  SettledTranscriptAvailability,
  TranscriptHandle,
} from "../domain/workspace/state.ts";

export interface ReadyWorkspaceTranscript<TTranscript> {
  readonly kind: "ready";
  readonly handle: TranscriptHandle;
  readonly value: TTranscript;
}

export type LoadedWorkspaceTranscript<TTranscript> =
  | ReadyWorkspaceTranscript<TTranscript>
  | Exclude<SettledTranscriptAvailability, { readonly kind: "ready" }>;

export type ExternalWorkspaceEffect = Exclude<
  WorkspaceEffect,
  { readonly type: "snapshot.load" | "transcript.load" | "diagnostic.record" }
>;

/** Aborted operations must not publish a successful or failed completion event. */
export interface WorkspaceEffectRuntime<TSnapshot, TTranscript> {
  loadSnapshot(signal: AbortSignal): Promise<WorkspaceSnapshotEnvelope<TSnapshot>>;
  loadTranscript(
    runId: RunId,
    signal: AbortSignal,
  ): Promise<LoadedWorkspaceTranscript<TTranscript>>;
  recordDiagnostic(error: WorkspaceError): void | Promise<void>;
  perform?(effect: ExternalWorkspaceEffect, signal: AbortSignal): void | Promise<void>;
}
